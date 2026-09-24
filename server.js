const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { categories: WORDS } = require('./words.json');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const LOBBY_GRACE_MS = 20000;    // 대기실에서 끊긴 플레이어 제거 유예
const ROOM_IDLE_MS = 10 * 60000; // 전원 오프라인인 방 삭제
const TURN_SECS = [30, 45, 60, 90];
const VOTE_SECS = [10, 15, 20, 30, 45];
const CUSTOM_CAT = '직접 입력';

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
const io = new Server(server);
const rooms = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const norm = s => String(s ?? '').replace(/\s+/g, '').toLowerCase();
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', A = L + D;
  const pick = s => s[crypto.randomInt(s.length)];
  let c;
  do c = shuffle([pick(L), pick(D), pick(A), pick(A), pick(A), pick(A)]).join(''); while (rooms.has(c));
  return c;
}

function newRoom() {
  const room = {
    code: makeCode(), hostId: null, players: [], state: 'lobby',
    category: '전체', customMode: false, custom: {}, turnSec: 45, voteSec: 20, maxPlayers: MAX_PLAYERS, wordList: [],
    turnIdx: -1, turnEnd: 0, q: null, noAsk: false, log: [], nextRank: 1, timer: null, idleTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}
function deleteRoom(room) {
  clearTimeout(room.timer); clearTimeout(room.idleTimer);
  room.players.forEach(p => clearTimeout(p.removeTimer));
  rooms.delete(room.code);
}

// rank: 0 = 진행 중, 1.. = 등수, -1 = 기권
const active = room => room.players.filter(p => !p.rank);
const host = room => room.players.find(p => p.id === room.hostId && p.sid) || room.players.find(p => p.sid);
const isHost = (room, me) => host(room) === me;
const addLog = (room, text, kind = 'info') => { room.log.push({ text, kind }); if (room.log.length > 200) room.log.shift(); };

function view(room, me) {
  const n = room.players.length, i = room.players.indexOf(me), tp = room.players[room.turnIdx];
  return {
    code: room.code, me: me.id, hostId: host(room)?.id, state: room.state,
    category: room.category, customMode: room.customMode, turnSec: room.turnSec,
    voteSec: room.voteSec, maxPlayers: room.maxPlayers, wordList: room.wordList,
    categories: ['전체', ...Object.keys(WORDS), CUSTOM_CAT],
    players: room.players.map(p => ({
      id: p.id, name: p.name, online: !!p.sid, ready: p.ready, rank: p.rank || 0, submitted: !!room.custom[p.id],
      // 핵심 규칙: 진행 중인 본인 제시어만 가림 (맞힌 뒤엔 공개)
      word: room.state === 'lobby' ? null : (p === me && !p.rank && room.state === 'playing') ? '???' : p.word,
    })),
    customTarget: room.customMode && n > 1 ? room.players[(i + 1) % n].name : null,
    myCustom: room.custom[me.id] || '',
    turnId: room.state === 'playing' && tp ? tp.id : null,
    remaining: Math.max(0, room.turnEnd - Date.now()),
    noAsk: room.noAsk,
    q: room.q && { text: room.q.text, votes: room.q.votes },
    log: room.log.slice(-80),
  };
}
function sync(room) {
  for (const p of room.players) if (p.sid) io.to(p.sid).emit('state', view(room, p));
}

function startGame(room) {
  const n = room.players.length;
  let words;
  if (room.customMode) {
    // 각 플레이어는 목록상 다음 사람의 제시어를 작성
    words = room.players.map((p, i) => room.custom[room.players[(i - 1 + n) % n].id]);
    if (words.some(w => !w)) return '모든 플레이어가 제시어를 입력해야 합니다.';
    if (new Set(words.map(norm)).size !== n) return '중복된 제시어가 있습니다.';
  } else {
    const pool = [...new Set(room.category === '전체' ? Object.values(WORDS).flat()
      : room.category === CUSTOM_CAT ? room.wordList : WORDS[room.category])];
    if (pool.length < n) return `제시어가 부족합니다 (${pool.length}개, 최소 ${n}개 필요).`;
    words = shuffle(pool).slice(0, n);
  }
  room.players.forEach((p, i) => Object.assign(p, { word: words[i], rank: 0, noAsk: false, penaltyUsed: false, ready: false }));
  Object.assign(room, { state: 'playing', log: [], nextRank: 1, q: null, turnIdx: -1 });
  addLog(room, '🎮 게임 시작! 내 제시어를 맞혀보세요.', 'sys');
  nextTurn(room);
}

function setDeadline(room, ms) {
  clearTimeout(room.timer);
  room.turnEnd = Date.now() + ms;
  room.timer = setTimeout(() => {
    if (room.q) return finishQuestion(room);
    addLog(room, `⏰ ${room.players[room.turnIdx].name}님 시간 초과`, 'warn');
    nextTurn(room);
  }, ms);
}

function nextTurn(room) {
  clearTimeout(room.timer);
  room.q = null;
  if (active(room).length <= 1) return endGame(room);
  const n = room.players.length;
  // 접속 끊긴 사람은 없는 걸로 보고 건너뜀
  let i = -1;
  for (let k = 1; k <= n && i < 0; k++) {
    const j = (room.turnIdx + k + n) % n;
    if (!room.players[j].rank && room.players[j].sid) i = j;
  }
  if (i < 0) return endGame(room);
  room.turnIdx = i;
  const p = room.players[i];
  room.noAsk = !!p.noAsk; p.noAsk = false;
  setDeadline(room, room.turnSec * 1000);
  addLog(room, `▶ ${p.name}님의 차례${room.noAsk ? ' (패널티: 질문 불가)' : ''}`, 'turn');
  sync(room);
}

function finishQuestion(room) {
  const c = { yes: 0, no: 0, maybe: 0 };
  Object.values(room.q.votes).forEach(v => c[v]++);
  addLog(room, `📊 결과 → 예 ${c.yes} / 아니오 ${c.no} / 모호함 ${c.maybe}`, 'result');
  nextTurn(room);
}

function checkVotes(room) {
  if (room.state !== 'playing' || !room.q) return;
  const tp = room.players[room.turnIdx];
  const voters = active(room).filter(p => p !== tp && p.sid);
  if (voters.every(p => room.q.votes[p.id])) finishQuestion(room);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.q = null;
  active(room).forEach(p => { p.rank = room.nextRank++; });
  room.state = 'result';
  addLog(room, '🏁 게임 종료!', 'sys');
  sync(room);
}

function toLobby(room) {
  clearTimeout(room.timer);
  room.players = room.players.filter(p => p.sid); // 오프라인·기권자는 정리
  room.players.forEach(p => Object.assign(p, { word: null, rank: 0, ready: false }));
  Object.assign(room, { state: 'lobby', q: null, custom: {}, log: [], turnIdx: -1 });
  if (!room.players.length) deleteRoom(room);
}

function removePlayer(room, p) {
  clearTimeout(p.removeTimer);
  room.players = room.players.filter(x => x !== p);
  room.custom = {}; // 작성 대상이 바뀌므로 초기화
  if (room.hostId === p.id) room.hostId = room.players[0]?.id;
  if (!room.players.length) return deleteRoom(room);
  sync(room);
}

function attach(socket, room, p) {
  clearTimeout(p.removeTimer);
  clearTimeout(room.idleTimer);
  if (p.sid && p.sid !== socket.id) io.to(p.sid).emit('kicked', '다른 창에서 접속했습니다.');
  p.sid = socket.id;
  socket.data = { code: room.code, pid: p.id };
  sync(room);
}

function join(socket, room, { name, token }) {
  if (typeof token !== 'string' || token.length < 16) return '잘못된 요청입니다.';
  let p = room.players.find(x => x.token === token);
  if (!p) {
    name = clean(name, 12);
    if (!name) return '닉네임을 입력하세요.';
    if (room.state !== 'lobby') return '이미 게임이 진행 중입니다.';
    if (room.players.length >= room.maxPlayers) return `방이 가득 찼습니다 (최대 ${room.maxPlayers}명).`;
    if (room.players.some(x => x.name === name)) return '이미 사용 중인 닉네임입니다.';
    p = { id: rid(), token, name, sid: null, ready: false, rank: 0 };
    room.players.push(p);
    room.custom = {};
    if (!room.hostId) room.hostId = p.id;
  }
  attach(socket, room, p);
}

io.on('connection', socket => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const me = room?.players.find(p => p.id === socket.data.pid);
    return me && me.sid === socket.id ? { room, me } : null;
  };

  socket.on('create', (d = {}, cb = () => {}) => {
    if (!clean(d.name, 12)) return cb({ error: '닉네임을 입력하세요.' });
    const room = newRoom();
    const err = join(socket, room, d);
    if (err) { deleteRoom(room); return cb({ error: err }); }
    cb({ code: room.code });
  });

  socket.on('join', (d = {}, cb = () => {}) => {
    const room = rooms.get(clean(d.code, 6).toUpperCase());
    if (!room) return cb({ error: '방을 찾을 수 없습니다.' });
    const err = join(socket, room, d);
    cb(err ? { error: err } : { code: room.code });
  });

  // 방 안에서의 행동: 에러 문자열을 반환하면 본인에게만 알림, 아니면 전체 동기화
  const on = (ev, fn) => socket.on(ev, (d) => {
    const c = ctx();
    if (!c) return;
    const err = fn(c.room, c.me, d && typeof d === 'object' ? d : {});
    if (err) socket.emit('err', err);
    else if (rooms.has(c.room.code)) sync(c.room);
  });

  on('ready', (room, me) => { if (room.state === 'lobby') me.ready = !me.ready; });

  on('settings', (room, me, d) => {
    if (!isHost(room, me) || room.state !== 'lobby') return '방장만 변경할 수 있습니다.';
    if (d.category === '전체' || d.category === CUSTOM_CAT || Object.hasOwn(WORDS, d.category)) room.category = d.category;
    if ('wordList' in d) room.wordList = [...new Set(String(d.wordList).split(/[,\n]/).map(w => clean(w, 20)).filter(Boolean))].slice(0, 200);
    if ('customMode' in d) { room.customMode = !!d.customMode; room.custom = {}; }
    if (TURN_SECS.includes(+d.turnSec)) room.turnSec = +d.turnSec;
    if (VOTE_SECS.includes(+d.voteSec)) room.voteSec = +d.voteSec;
    if ('maxPlayers' in d) {
      const m = Math.trunc(+d.maxPlayers);
      if (m < 2 || m > MAX_PLAYERS) return;
      if (m < room.players.length) return `현재 인원(${room.players.length}명)보다 적게 설정할 수 없습니다.`;
      room.maxPlayers = m;
    }
  });

  on('customWord', (room, me, d) => {
    if (room.state !== 'lobby' || !room.customMode) return;
    const w = clean(d.word, 20);
    if (!w) return '제시어를 입력하세요.';
    room.custom[me.id] = w;
  });

  on('kick', (room, me, d) => {
    if (!isHost(room, me) || room.state !== 'lobby') return '방장만 강퇴할 수 있습니다.';
    const t = room.players.find(p => p.id === d.id);
    if (!t || t === me) return;
    if (t.sid) io.to(t.sid).emit('kicked', '방장에 의해 퇴장되었습니다.');
    removePlayer(room, t);
  });

  on('start', (room, me) => {
    if (!isHost(room, me)) return '방장만 시작할 수 있습니다.';
    if (room.state !== 'lobby') return;
    if (room.players.length < 2) return '최소 2명이 필요합니다.';
    if (room.players.some(p => p !== me && !p.ready)) return '모든 플레이어가 준비 완료해야 시작할 수 있습니다.';
    return startGame(room);
  });

  on('ask', (room, me, d) => {
    if (room.state !== 'playing' || room.players[room.turnIdx] !== me || room.q) return '지금은 질문할 수 없습니다.';
    if (room.noAsk) return '패널티로 이번 턴에는 질문할 수 없습니다.';
    const text = clean(d.text, 100);
    if (!text) return '질문을 입력하세요.';
    room.q = { text, votes: {} };
    addLog(room, `❓ ${me.name}: ${text}`, 'question');
    setDeadline(room, room.voteSec * 1000); // 질문 후엔 투표 시간으로 타이머 재설정
    checkVotes(room);
  });

  on('vote', (room, me, d) => {
    if (room.state !== 'playing' || !room.q || me.rank || room.players[room.turnIdx] === me) return;
    if (!['yes', 'no', 'maybe'].includes(d.answer)) return;
    room.q.votes[me.id] = d.answer;
    checkVotes(room);
  });

  on('guess', (room, me, d) => {
    if (room.state !== 'playing' || room.players[room.turnIdx] !== me || room.q) return '지금은 정답을 도전할 수 없습니다.';
    const text = clean(d.text, 20);
    if (!text) return '정답을 입력하세요.';
    if (norm(text) === norm(me.word)) {
      me.rank = room.nextRank++;
      addLog(room, `🎉 ${me.name}님 정답! "${me.word}" — ${me.rank}등`, 'correct');
    } else {
      addLog(room, `❌ ${me.name}님 오답: "${text}"`, 'wrong');
      if (!me.penaltyUsed) {
        me.penaltyUsed = me.noAsk = true;
        addLog(room, `⚠️ ${me.name}님은 다음 턴에 질문할 수 없습니다.`, 'warn');
      }
    }
    nextTurn(room);
  });

  on('again', (room, me) => {
    if (!isHost(room, me) || room.state !== 'result') return;
    toLobby(room);
    if (room.customMode) return; // 커스텀 모드는 대기실에서 제시어를 다시 입력
    if (room.players.length < 2) return;
    return startGame(room);
  });

  on('toLobby', (room, me) => {
    if (!isHost(room, me) || room.state !== 'result') return;
    toLobby(room);
  });

  on('leave', (room, me) => {
    socket.data = {};
    if (room.state === 'playing') {
      Object.assign(me, { sid: null, token: null });
      if (!me.rank) {
        me.rank = -1;
        addLog(room, `🚪 ${me.name}님이 기권했습니다.`, 'warn');
        if (room.players[room.turnIdx] === me) nextTurn(room);
        else if (active(room).length <= 1) endGame(room);
        else checkVotes(room);
      }
      return;
    }
    removePlayer(room, me);
  });

  socket.on('disconnect', () => {
    const c = ctx();
    if (!c) return;
    const { room, me } = c;
    me.sid = null;
    if (room.state === 'lobby') me.removeTimer = setTimeout(() => {
      if (room.state === 'lobby' && !me.sid) removePlayer(room, me);
    }, LOBBY_GRACE_MS);
    if (room.state === 'playing' && room.players[room.turnIdx] === me) {
      addLog(room, `📴 ${me.name}님 연결 끊김 — 턴을 건너뜁니다.`, 'warn');
      nextTurn(room);
    } else checkVotes(room);
    if (!room.players.some(p => p.sid)) room.idleTimer = setTimeout(() => deleteRoom(room), ROOM_IDLE_MS);
    if (rooms.has(room.code)) sync(room);
  });
});

server.listen(PORT, () => console.log(`양세찬 게임 서버: http://localhost:${server.address().port}`));
module.exports = server;

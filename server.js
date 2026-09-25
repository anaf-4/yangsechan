const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { categories: WORDS, aliases: ALIASES = {} } = require('./words.json');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const LOBBY_GRACE_MS = 20000;    // 대기실에서 끊긴 플레이어 제거 유예
const TURN_GRACE_MS = +process.env.TURN_GRACE_MS || 15000; // 게임 중 끊긴 플레이어 차례를 넘기기 전 대기
const ROOM_IDLE_MS = 10 * 60000; // 전원 오프라인인 방 삭제
const COUNTDOWN_MS = process.env.COUNTDOWN_MS ? +process.env.COUNTDOWN_MS : 5000; // 게임 시작 카운트다운
const TURN_SECS = [30, 45, 60, 90];
const VOTE_SECS = [10, 15, 20, 30, 45];
const CUSTOM_CAT = '직접 입력';
const HINT_EVERY = 5;            // 질문 5번마다 힌트 1개
const HINT_LEVELS = 3;           // 글자 수 → 초성 1개 → 글자 1개
const REACTIONS = ['😂', '🤔', '👍', '😮', '🔥', '👏'];
const CHAT_GAP_MS = 800;         // 채팅·리액션 도배 방지

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  // 아이콘·미리보기 이미지(public/*.png)와 효과음(public/sfx/*.mp3) — 이름 규칙으로 경로 조작 차단
  const asset = req.url.match(/^\/(?:[\w-]+\.png|sfx\/[\w-]+\.mp3)$/);
  if (asset) {
    return fs.readFile(path.join(__dirname, 'public', req.url.slice(1)), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.mp3') ? 'audio/mpeg' : 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
const io = new Server(server);
const rooms = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
// 정답 비교용: 띄어쓰기·문장부호·대소문자 무시
const norm = s => String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const isCorrect = (guess, word) => [word, ...(ALIASES[word] || [])].some(w => norm(w) === norm(guess));

// ---- 채팅·질문 가리기 ----
// 비교용 글자만 남기기 (욕설은 숫자까지 빼서 "시1발" 같은 우회도 잡음)
const flat = (s, digits = true) => [...String(s).normalize('NFC').toLowerCase()].filter(c => (digits ? /[\p{L}\p{N}]/u : /\p{L}/u).test(c));
// text 안에서 needles가 나오는 부분을 원문 위치 기준으로 *로 가림 (사이에 낀 띄어쓰기·기호 포함)
function maskText(text, needles, digits = true) {
  const chars = [...text], letters = [], pos = [];
  chars.forEach((c, i) => { if (flat(c, digits).length) { letters.push(flat(c, digits)[0]); pos.push(i); } });
  const hide = new Set();
  for (const nd of needles) {
    for (let at = 0; at + nd.length <= letters.length; at++) {
      if (nd.every((c, k) => letters[at + k] === c)) for (let i = pos[at]; i <= pos[at + nd.length - 1]; i++) hide.add(i);
    }
  }
  return hide.size ? chars.map((c, i) => hide.has(i) ? '*' : c).join('') : text;
}
const BAD_WORDS = ['시발', '씨발', '씨바', '씨빨', '시빨', 'ㅅㅂ', 'ㅆㅂ', '병신', '븅신', 'ㅂㅅ', '좆', '존나', '졸라', '개새끼', '개색', '새끼', 'ㅅㄲ',
  '미친놈', '미친년', '지랄', 'ㅈㄹ', '엠창', '느금', '니애미', '니미', '애미', '애비', '닥쳐', '꺼져', 'fuck', 'shit', 'bitch', 'sibal'].map(w => flat(w, false));
const hasBad = s => maskText(s, BAD_WORDS, false) !== s;
// 아직 못 맞힌 다른 사람의 제시어·별칭 (한 글자짜리는 너무 자주 걸려서 제외)
const spoilers = (room, me) => room.state !== 'playing' ? [] : room.players
  .filter(p => !p.rank && p !== me && p.word)
  .flatMap(p => [p.word, ...(ALIASES[p.word] || [])]).map(w => flat(w)).filter(w => w.length >= 2);
const cleanText = (room, me, s) => maskText(maskText(s, BAD_WORDS, false), spoilers(room, me));
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

// 힌트: 1단계 글자 수(3글자), 2단계 무작위 한 글자의 초성(□ㅇ□), 3단계 다른 한 글자 공개(고ㅇ□)
// pos = [초성을 보여줄 글자 순번, 통째로 보여줄 글자 순번] (띄어쓰기 뺀 글자 기준, 게임마다 무작위)
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const chosung = c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; };
const letterCount = word => [...word].filter(c => c.trim()).length;
function hintPos(word) {
  const n = letterCount(word) || 1, a = crypto.randomInt(n);
  return [a, n > 1 ? (a + 1 + crypto.randomInt(n - 1)) % n : a];
}
function hintText(word, level, pos = [0, 1]) {
  if (level === 1) return `${letterCount(word)}글자`;
  let k = -1;
  return [...word].map(c => {
    if (!c.trim()) return ' ';
    k++;
    if (level >= 3 && k === pos[1]) return c;
    return k === pos[0] ? chosung(c) : '□';
  }).join('');
}
// 아깝다 판정: 정답(별칭 포함)과 글자 하나만 다르면 true (한 글자 바꿈·빠짐·더함)
function nearMiss(guess, word) {
  const g = [...norm(guess)];
  return [word, ...(ALIASES[word] || [])].some(w => {
    const t = [...norm(w)];
    if (t.length < 2 || Math.abs(t.length - g.length) > 1) return false;
    const d = Array.from({ length: g.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= t.length; j++) d[0][j] = j;
    for (let i = 1; i <= g.length; i++) for (let j = 1; j <= t.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (g[i - 1] === t[j - 1] ? 0 : 1));
    return d[g.length][t.length] === 1;
  });
}

// 아바타: 색 번호 + 동물 아이콘(없으면 이름 첫 글자)
const AVATAR_COLORS = 8;
const AVATAR_ICONS = ['🐶', '🐱', '🐰', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐧', '🐙', '🦄'];
const cleanAvatar = a => ({
  c: Number.isInteger(a?.c) && a.c >= 0 && a.c < AVATAR_COLORS ? a.c : null,
  e: AVATAR_ICONS.includes(a?.e) ? a.e : '',
});

// 서로 지정 모드: 누가 누구의 제시어를 쓸지 무작위로 섞음 (자기 자신 제외) → 누가 썼는지 알 수 없게
function assignTargets(room) {
  room.custom = {};
  room.customTargets = {};
  const ids = room.players.map(p => p.id);
  if (!room.customMode || ids.length < 2) return;
  let perm;
  do perm = shuffle([...ids]); while (perm.some((t, i) => t === ids[i]));
  ids.forEach((id, i) => { room.customTargets[id] = perm[i]; });
}

const hintsLeft = p => Math.min(HINT_LEVELS, Math.floor((p.qCount || 0) / HINT_EVERY)) - (p.hintsUsed || 0);

function newRoom(isPublic) {
  const room = {
    isPublic: !!isPublic,
    code: makeCode(), hostId: null, players: [], state: 'lobby',
    category: '전체', customMode: false, custom: {}, turnSec: 45, voteSec: 20, maxPlayers: MAX_PLAYERS, wordList: [],
    spectatorVote: true, round: 0, usedWords: new Set(), banned: new Set(),
    turnIdx: -1, turnEnd: 0, q: null, noAsk: false, log: [], nextRank: 1, timer: null, idleTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}
function deleteRoom(room) {
  clearTimeout(room.timer); clearTimeout(room.idleTimer); clearTimeout(room.graceTimer);
  room.players.forEach(p => clearTimeout(p.removeTimer));
  rooms.delete(room.code);
}

// rank: 0 = 진행 중, 1.. = 등수, -1 = 기권·퇴장
const active = room => room.players.filter(p => !p.rank);
const host = room => room.players.find(p => p.id === room.hostId && p.sid) || room.players.find(p => p.sid);
const isHost = (room, me) => host(room) === me;
// 기록마다 번호를 붙여 클라이언트가 "새로 생긴 일"만 골라 효과음을 낼 수 있게 함
const addLog = (room, text, kind = 'info') => { room.log.push({ id: room.logSeq = (room.logSeq || 0) + 1, text, kind }); if (room.log.length > 200) room.log.shift(); };
// 답변할 수 있는 사람: 차례인 사람 제외, 아직 못 맞힌 사람 (+ 설정 시 맞힌 관전자)
const canVote = (room, p) => p !== room.players[room.turnIdx] && p.rank >= 0 && (!p.rank || room.spectatorVote);
const emitAll = (room, ev, data) => { for (const p of room.players) if (p.sid) io.to(p.sid).emit(ev, data); };

function view(room, me) {
  const tp = room.players[room.turnIdx];
  const hiding = room.state === 'playing' && !me.rank; // 내 제시어를 아직 모르는 상태
  return {
    code: room.code, me: me.id, hostId: host(room)?.id, state: room.state,
    category: room.category, customMode: room.customMode, turnSec: room.turnSec,
    voteSec: room.voteSec, maxPlayers: room.maxPlayers, wordList: room.wordList, isPublic: room.isPublic,
    spectatorVote: room.spectatorVote, round: room.round, reactions: REACTIONS, hintEvery: HINT_EVERY,
    categories: ['전체', ...Object.keys(WORDS), CUSTOM_CAT], avatarIcons: AVATAR_ICONS,
    players: room.players.map(p => ({
      id: p.id, name: p.name, av: p.av, online: !!p.sid, kicked: !!p.kicked, watching: !!p.watching, ready: p.ready, rank: p.rank || 0, submitted: !!room.custom[p.id],
      qCount: p.qCount || 0, score: p.score || 0, lastPoints: p.lastPoints ?? null,
      // 핵심 규칙: 진행 중인 본인 제시어만 가림 (맞힌 뒤엔 공개)
      word: room.state === 'lobby' ? null : (p === me && hiding) ? '???' : p.word,
    })),
    customTarget: room.players.find(p => p.id === room.customTargets?.[me.id])?.name || null,
    myCustom: room.custom[me.id] || '',
    myHint: hiding && me.hintsUsed ? hintText(me.word, me.hintsUsed, me.hintPos) : '',
    myQuestions: room.state === 'lobby' ? [] : (me.qHistory || []),
    hintsLeft: hiding ? hintsLeft(me) : 0,
    turnId: room.state === 'playing' && !room.paused && tp ? tp.id : null,
    remaining: Math.max(0, room.turnEnd - Date.now()),
    startsIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : 0,
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
    // 무작위로 배정된 사람이 쓴 제시어를 받음
    const writerOf = id => Object.keys(room.customTargets || {}).find(w => room.customTargets[w] === id);
    if (room.players.some(p => !writerOf(p.id))) { assignTargets(room); return '인원이 바뀌어 제시어 배정을 다시 했어요. 다시 입력해 주세요.'; }
    words = room.players.map(p => room.custom[writerOf(p.id)]);
    if (words.some(w => !w)) return '모든 플레이어가 제시어를 입력해야 합니다.';
    if (new Set(words.map(norm)).size !== n) return '중복된 제시어가 있습니다.';
  } else {
    const all = [...new Set(room.category === '전체' ? Object.values(WORDS).flat()
      : room.category === CUSTOM_CAT ? room.wordList : WORDS[room.category])];
    if (all.length < n) return `제시어가 부족합니다 (${all.length}개, 최소 ${n}개 필요).`;
    // 이 방에서 이미 나온 제시어는 빼고, 모자라면 다시 처음부터
    let pool = all.filter(w => !room.usedWords.has(w));
    if (pool.length < n) { room.usedWords.clear(); pool = all; }
    words = shuffle(pool).slice(0, n);
    words.forEach(w => room.usedWords.add(w));
  }
  room.players.forEach((p, i) => Object.assign(p, {
    word: words[i], rank: 0, watching: false, noAsk: false, penaltyUsed: false, ready: false, qCount: 0, qHistory: [], hintsUsed: 0, hintPos: hintPos(words[i]), lastPoints: null,
  }));
  Object.assign(room, { state: 'playing', log: [], nextRank: 1, q: null, turnIdx: -1, paused: false, roundSize: n });
  addLog(room, `🎮 ${room.round + 1}번째 게임 시작! 내 제시어를 맞혀보세요.`, 'sys');
  // 카운트다운 동안은 차례 없음 → 끝나면 첫 턴
  clearTimeout(room.timer);
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.timer = setTimeout(() => { room.startAt = 0; nextTurn(room); }, COUNTDOWN_MS);
  sync(room);
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

// 방금 끊긴 사람은 잠깐 기다려 줌 (휴대폰 화면 꺼짐·앱 전환 대비)
const graceLeft = p => p.sid ? Infinity : TURN_GRACE_MS - (Date.now() - (p.offlineAt || 0));

function waitForReturn(room, p) {
  clearTimeout(room.graceTimer);
  addLog(room, `📴 ${p.name}님 연결 끊김 — ${Math.ceil(graceLeft(p) / 1000)}초 기다립니다.`, 'warn');
  room.graceTimer = setTimeout(() => {
    if (room.state !== 'playing' || room.players[room.turnIdx] !== p || p.sid) return;
    addLog(room, `⏭ ${p.name}님이 돌아오지 않아 턴을 넘깁니다.`, 'warn');
    nextTurn(room);
  }, Math.max(0, graceLeft(p)));
}

function nextTurn(room) {
  clearTimeout(room.timer); clearTimeout(room.graceTimer);
  room.q = null;
  if (active(room).length <= 1) return endGame(room);
  const n = room.players.length;
  // 오래 끊긴 사람은 없는 걸로 보고 건너뜀
  let i = -1;
  for (let k = 1; k <= n && i < 0; k++) {
    const j = (room.turnIdx + k + n) % n;
    if (!room.players[j].rank && graceLeft(room.players[j]) > 0) i = j;
  }
  if (i < 0) {
    // 남은 사람이 모두 끊긴 상태: 게임을 끝내지 않고 누군가 돌아올 때까지 대기
    room.paused = true; room.turnEnd = 0;
    addLog(room, '⏸ 남은 플레이어의 재접속을 기다립니다…', 'warn');
    return sync(room);
  }
  room.paused = false;
  room.turnIdx = i;
  const p = room.players[i];
  room.noAsk = !!p.noAsk; p.noAsk = false;
  setDeadline(room, room.turnSec * 1000);
  addLog(room, `▶ ${p.name}님의 차례${room.noAsk ? ' (패널티: 질문 불가)' : ''}`, 'turn');
  if (!p.sid) waitForReturn(room, p);
  sync(room);
}

function finishQuestion(room) {
  const c = { yes: 0, no: 0, maybe: 0 };
  Object.values(room.q.votes).forEach(v => c[v]++);
  addLog(room, `📊 결과 → 예 ${c.yes} / 아니오 ${c.no} / 모호함 ${c.maybe}`, 'result');
  // 질문한 사람의 "내 질문 기록"에 결과와 함께 남김
  const asker = room.players[room.turnIdx];
  if (asker) (asker.qHistory ||= []).push({ text: room.q.text, ...c });
  nextTurn(room);
}

function checkVotes(room) {
  if (room.state !== 'playing' || !room.q) return;
  const voters = room.players.filter(p => p.sid && canVote(room, p));
  if (voters.every(p => room.q.votes[p.id])) finishQuestion(room);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.q = null; room.startAt = 0;
  active(room).forEach(p => { p.rank = room.nextRank++; });
  // 누적 점수: 참가 인원 n명일 때 1등 n-1점, 2등 n-2점 … 꼴찌·기권 0점
  const n = room.roundSize || room.players.length;
  room.players.forEach(p => { p.lastPoints = p.rank > 0 ? Math.max(0, n - p.rank) : 0; p.score = (p.score || 0) + p.lastPoints; });
  room.round++;
  room.state = 'result';
  addLog(room, '🏁 게임 종료!', 'sys');
  sync(room);
}

// 게임 중 이탈(기권·강퇴): 자리는 남기되 순위에서 빠지고 재입장 불가
function forfeit(room, p, text, kicked = false) {
  Object.assign(p, { sid: null, token: null, kicked });
  if (p.rank) return;
  p.rank = -1;
  addLog(room, text, 'warn');
  if (room.players[room.turnIdx] === p && !room.startAt) nextTurn(room);
  else if (active(room).length <= 1) endGame(room);
  else checkVotes(room);
}

function toLobby(room) {
  clearTimeout(room.timer);
  room.players = room.players.filter(p => p.sid); // 오프라인·기권자는 정리
  room.players.forEach(p => Object.assign(p, { word: null, rank: 0, ready: false, watching: false }));
  Object.assign(room, { state: 'lobby', q: null, log: [], turnIdx: -1, paused: false });
  assignTargets(room);
  if (!room.players.length) deleteRoom(room);
}

function removePlayer(room, p) {
  clearTimeout(p.removeTimer);
  room.players = room.players.filter(x => x !== p);
  addLog(room, `🚪 ${p.name}님이 나갔습니다.`, 'sys');
  if (room.state === 'lobby') assignTargets(room); // 작성 대상이 바뀌므로 다시 배정
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
  if (room.state === 'playing' && room.paused && !p.rank) return nextTurn(room);
  sync(room);
}

function join(socket, room, { name, token, avatar }) {
  if (typeof token !== 'string' || token.length < 16) return '잘못된 요청입니다.';
  let p = room.players.find(x => x.token === token);
  if (!p) {
    name = clean(name, 12);
    if (!name) return '닉네임을 입력하세요.';
    if (room.players.length >= room.maxPlayers) return `방이 가득 찼습니다 (최대 ${room.maxPlayers}명).`;
    if (room.players.some(x => x.name === name)) return '이미 사용 중인 닉네임입니다.';
    if (hasBad(name)) return '사용할 수 없는 닉네임입니다.';
    if (room.banned.has(token) || room.banned.has('name:' + norm(name))) return '이 방에서 강퇴되어 다시 들어갈 수 없습니다.';
    // 게임 중에 들어오면 관전자(rank -2: 차례·투표·순위에서 빠짐) → 다음 판부터 참가
    const watching = room.state === 'playing';
    p = { id: rid(), token, name, av: cleanAvatar(avatar), sid: null, ready: false, rank: watching ? -2 : 0, watching, score: 0 };
    room.players.push(p);
    addLog(room, watching ? `👀 ${name}님이 관전하러 들어왔습니다. 다음 판부터 참가해요.` : `👋 ${name}님이 들어왔습니다.`, 'sys');
    if (room.state === 'lobby') assignTargets(room);
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

  socket.on('rooms', (cb) => {
    if (typeof cb !== 'function') return;
    cb([...rooms.values()]
      .filter(r => r.isPublic && r.players.length < r.maxPlayers && host(r))
      .map(r => ({ code: r.code, host: host(r).name, hostAv: host(r).av, count: r.players.length, max: r.maxPlayers, status: r.state,
        category: r.customMode ? '서로 지정' : r.category })));
  });

  // 이미 다른 방에 있으면 그 방에서 먼저 나감 (빈 방이 남지 않게)
  const leaveCurrent = (keepCode) => {
    const c = ctx();
    if (!c || c.room.code === keepCode) return;
    socket.data = {};
    if (c.room.state === 'playing') { forfeit(c.room, c.me, `🚪 ${c.me.name}님이 나갔습니다.`); if (rooms.has(c.room.code)) sync(c.room); }
    else removePlayer(c.room, c.me);
  };

  socket.on('create', (d = {}, cb = () => {}) => {
    if (!clean(d.name, 12)) return cb({ error: '닉네임을 입력하세요.' });
    if (hasBad(d.name)) return cb({ error: '사용할 수 없는 닉네임입니다.' });
    leaveCurrent();
    const room = newRoom(d.isPublic);
    const err = join(socket, room, d);
    if (err) { deleteRoom(room); return cb({ error: err }); }
    cb({ code: room.code });
  });

  socket.on('join', (d = {}, cb = () => {}) => {
    const room = rooms.get(clean(d.code, 6).toUpperCase());
    if (!room) return cb({ error: '방을 찾을 수 없습니다.' });
    leaveCurrent(room.code);
    const err = join(socket, room, d);
    cb(err ? { error: err } : { code: room.code });
  });

  // 리액션: 기록에 남기지 않고 화면에 잠깐 띄우기만 함
  socket.on('react', (d) => {
    const c = ctx();
    if (!c || c.room.state !== 'playing' || !REACTIONS.includes(d?.e)) return;
    if (Date.now() - (c.me.lastReact || 0) < CHAT_GAP_MS / 2) return;
    c.me.lastReact = Date.now();
    emitAll(c.room, 'reaction', { id: c.me.id, e: d.e });
  });

  // 방 안에서의 행동: 에러 문자열을 반환하면 본인에게만 알림, 아니면 전체 동기화
  const on = (ev, fn) => socket.on(ev, (d) => {
    const c = ctx();
    if (!c) return;
    const err = fn(c.room, c.me, d && typeof d === 'object' ? d : {});
    if (err) socket.emit('err', err);
    else if (rooms.has(c.room.code)) sync(c.room);
  });

  on('ready', (room, me) => { if (room.state === 'lobby' || room.state === 'result') me.ready = !me.ready; });

  on('makeHost', (room, me, d) => {
    if (!isHost(room, me) || room.state === 'playing') return '방장만 넘길 수 있습니다.';
    const t = room.players.find(p => p.id === d.id);
    if (!t || t === me) return;
    if (!t.sid) return '접속 중인 사람에게만 넘길 수 있습니다.';
    room.hostId = t.id;
    addLog(room, `👑 ${t.name}님이 방장이 되었습니다.`, 'sys');
  });

  on('settings', (room, me, d) => {
    if (!isHost(room, me) || room.state !== 'lobby') return '방장만 변경할 수 있습니다.';
    if (d.category === '전체' || d.category === CUSTOM_CAT || Object.hasOwn(WORDS, d.category)) room.category = d.category;
    if ('wordList' in d) room.wordList = [...new Set(String(d.wordList).split(/[,\n]/).map(w => clean(w, 20)).filter(Boolean))].slice(0, 200);
    if ('isPublic' in d) room.isPublic = !!d.isPublic;
    if ('spectatorVote' in d) room.spectatorVote = !!d.spectatorVote;
    if ('customMode' in d) { room.customMode = !!d.customMode; assignTargets(room); }
    if (TURN_SECS.includes(+d.turnSec)) room.turnSec = +d.turnSec;
    if (VOTE_SECS.includes(+d.voteSec)) room.voteSec = +d.voteSec;
    if ('maxPlayers' in d) {
      const m = Math.trunc(+d.maxPlayers);
      if (m < 2 || m > MAX_PLAYERS) return;
      if (m < room.players.length) return `현재 인원(${room.players.length}명)보다 적게 설정할 수 없습니다.`;
      room.maxPlayers = m;
    }
  });

  on('resetScores', (room, me) => {
    if (!isHost(room, me) || room.state !== 'lobby') return '방장만 초기화할 수 있습니다.';
    room.players.forEach(p => { p.score = 0; p.lastPoints = null; });
    room.round = 0;
  });

  on('customWord', (room, me, d) => {
    if (room.state !== 'lobby' || !room.customMode) return;
    const w = clean(d.word, 20);
    if (!w) return '제시어를 입력하세요.';
    room.custom[me.id] = w;
  });

  on('kick', (room, me, d) => {
    if (!isHost(room, me)) return '방장만 강퇴할 수 있습니다.';
    const t = room.players.find(p => p.id === d.id);
    if (!t || t === me) return;
    if (t.sid) io.to(t.sid).emit('kicked', '방장에 의해 퇴장되었습니다.');
    if (t.token) room.banned.add(t.token);
    room.banned.add('name:' + norm(t.name));
    if (room.state === 'playing') return forfeit(room, t, `🚪 ${t.name}님이 강퇴되었습니다.`, true);
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
    const text = cleanText(room, me, clean(d.text, 100));
    if (!text) return '질문을 입력하세요.';
    room.q = { text, votes: {} };
    me.qCount = (me.qCount || 0) + 1;
    addLog(room, `❓ ${me.name}: ${text}`, 'question');
    if (me.qCount % HINT_EVERY === 0 && me.qCount / HINT_EVERY <= HINT_LEVELS) addLog(room, `💡 ${me.name}님이 힌트를 얻었습니다.`, 'info');
    setDeadline(room, room.voteSec * 1000); // 질문 후엔 투표 시간으로 타이머 재설정
    checkVotes(room);
  });

  on('vote', (room, me, d) => {
    if (room.state !== 'playing' || !room.q || !canVote(room, me)) return;
    if (!['yes', 'no', 'maybe'].includes(d.answer)) return;
    room.q.votes[me.id] = d.answer;
    checkVotes(room);
  });

  on('hint', (room, me) => {
    if (room.state !== 'playing' || me.rank) return;
    if (hintsLeft(me) <= 0) return `질문을 ${HINT_EVERY}번 할 때마다 힌트를 1개 얻어요.`;
    me.hintsUsed = (me.hintsUsed || 0) + 1;
    addLog(room, `💡 ${me.name}님이 힌트를 사용했습니다. (${['', '글자 수', '초성 1개', '글자 1개'][me.hintsUsed]})`, 'info');
  });

  on('chat', (room, me, d) => {
    if (room.state === 'result') return;
    const text = cleanText(room, me, clean(d.text, 60));
    if (!text) return;
    if (Date.now() - (me.lastSaid || 0) < CHAT_GAP_MS) return '너무 빨라요. 잠시 후 다시 보내 주세요.';
    me.lastSaid = Date.now();
    addLog(room, `${me.name}: ${text}`, 'chat');
  });

  on('guess', (room, me, d) => {
    if (room.state !== 'playing' || room.players[room.turnIdx] !== me || room.q) return '지금은 정답을 도전할 수 없습니다.';
    const text = clean(d.text, 20);
    if (!text) return '정답을 입력하세요.';
    if (isCorrect(text, me.word)) {
      me.rank = room.nextRank++;
      addLog(room, `🎉 ${me.name}님 정답! "${me.word}" — ${me.rank}등`, 'correct');
    } else {
      addLog(room, `❌ ${me.name}님 오답: "${text}"`, 'wrong');
      if (nearMiss(text, me.word)) addLog(room, `😮 아까워요! ${me.name}님, 한 글자 차이예요.`, 'close');
      if (!me.penaltyUsed) {
        me.penaltyUsed = me.noAsk = true;
        addLog(room, `⚠️ ${me.name}님은 다음 턴에 질문할 수 없습니다.`, 'warn');
      }
    }
    nextTurn(room);
  });

  on('pass', (room, me) => {
    if (room.state !== 'playing' || room.players[room.turnIdx] !== me || room.q) return '지금은 패스할 수 없습니다.';
    addLog(room, `⏭ ${me.name}님이 패스했습니다.`, 'info');
    nextTurn(room);
  });

  on('again', (room, me) => {
    if (!isHost(room, me) || room.state !== 'result') return;
    const waiting = room.players.filter(p => p !== me && p.sid && !p.ready).length;
    if (waiting) return `${waiting}명이 아직 준비하지 않았어요.`;
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
    if (room.state === 'playing') return forfeit(room, me, `🚪 ${me.name}님이 기권했습니다.`);
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
    me.offlineAt = Date.now();
    if (room.state === 'playing' && !room.paused && room.players[room.turnIdx] === me) waitForReturn(room, me);
    checkVotes(room);
    if (!room.players.some(p => p.sid)) room.idleTimer = setTimeout(() => deleteRoom(room), ROOM_IDLE_MS);
    if (rooms.has(room.code)) sync(room);
  });
});

// Render가 새 버전을 배포하며 이 서버를 끌 때: 접속자에게 알리고 종료 (방은 메모리에만 있어 사라짐)
process.on('SIGTERM', () => {
  for (const room of rooms.values()) emitAll(room, 'serverRestart');
  setTimeout(() => process.exit(0), 1000);
});

server.listen(PORT, () => console.log(`양세찬 게임 서버: http://localhost:${server.address().port}`));
module.exports = { server, isCorrect, hintText, norm, maskText, flat, hasBad, nearMiss };

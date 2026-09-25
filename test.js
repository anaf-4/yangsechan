// 핵심 게임 흐름 자가 점검: node test.js
process.env.PORT = 0;
process.env.TURN_GRACE_MS = 300;
process.env.COUNTDOWN_MS = 200;
const assert = require('assert');
const { io } = require('socket.io-client');
const { server, isCorrect, hintText } = require('./server');

// 정답 판정: 띄어쓰기·문장부호·대소문자 무시 + 별칭
assert.ok(isCorrect('아이언 맨!', '아이언맨'));
assert.ok(isCorrect('Iron-Man', '아이언맨'));
assert.ok(isCorrect('핸드폰', '스마트폰'));
assert.ok(!isCorrect('아이언', '아이언맨'));
assert.ok(isCorrect('고 양 이', '고양이'));
// 힌트 단계
assert.equal(hintText('고양이', 1), '3글자');
assert.equal(hintText('고양이', 2), 'ㄱㅇㅇ');
assert.equal(hintText('고양이', 3), '고ㅇㅇ');
assert.equal(hintText('토이 스토리', 1), '5글자');

const wait = (sock, ev) => new Promise(r => sock.once(ev, r));
const emitCb = (sock, ev, d) => new Promise(r => sock.emit(ev, d, r));
const nextState = (sock, pred = () => true) => new Promise(r => {
  const h = s => { if (pred(s)) { sock.off('state', h); r(s); } };
  sock.on('state', h);
});

server.on('listening', async () => {
  const url = `http://localhost:${server.address().port}`;
  const mk = () => io(url, { forceNew: true });
  const [a, b, c] = [mk(), mk(), mk()];
  await Promise.all([a, b, c].map(s => wait(s, 'connect')));
  const tok = n => n.repeat(16);

  const { code } = await emitCb(a, 'create', { name: 'A', token: tok('a'), isPublic: true });
  const priv = await emitCb(c, 'create', { name: 'P', token: tok('p') });
  const list = await new Promise(r => b.emit('rooms', r));
  assert.ok(list.some(r => r.code === code && r.host === 'A'), '공개방 목록에 표시');
  assert.ok(!list.some(r => r.code === priv.code), '비공개방은 목록에 없음');
  c.emit('leave');
  assert.match(code, /^(?=.*[A-Z])(?=.*\d)[A-Z\d]{6}$/);
  assert.equal((await emitCb(b, 'join', { code, name: 'A', token: tok('x') })).error, '이미 사용 중인 닉네임입니다.');
  await emitCb(b, 'join', { code, name: 'B', token: tok('b') });
  await emitCb(c, 'join', { code, name: 'C', token: tok('c') });

  // 준비 안 된 플레이어가 있으면 시작 불가
  const e0 = wait(a, 'err'); a.emit('start');
  assert.match(await e0, /준비/);
  await new Promise(r => { a.once('state', r); b.emit('ready'); });
  await new Promise(r => { a.once('state', r); c.emit('ready'); });

  // 제시어: 본인만 ???
  // 시작 직후엔 카운트다운(차례 없음) → 끝나면 첫 턴
  const cd = nextState(a, s => s.state === 'playing');
  const first = s => s.state === 'playing' && s.turnId;
  const pc = nextState(c, first), pb = nextState(b, first), pa = nextState(a, first);
  a.emit('start');
  const s0 = await cd;
  assert.ok(s0.startsIn > 0 && s0.turnId === null, '카운트다운 중엔 차례 없음');
  const [sa, sb, sc] = await Promise.all([pa, pb, pc]);
  const words = sb.players.map(p => p.word);
  assert.equal(sa.players[0].word, '???');
  assert.equal(sb.players[1].word, '???');
  assert.equal(sa.players[1].word, sc.players[1].word);
  const realA = sb.players[0].word, realB = sa.players[1].word;
  assert.equal(new Set([realA, realB, sa.players[2].word]).size, 3, '중복 제시어');
  assert.equal(sa.turnId, sa.players[0].id);

  // A 질문 → B, C 투표 → B 차례
  a.emit('ask', { text: '나는 동물인가요?' });
  await nextState(b, s => !!s.q);
  b.emit('vote', { answer: 'yes' });
  const bTurn = nextState(a, s => s.turnId === s.players[1].id);
  c.emit('vote', { answer: 'no' });
  const s1 = await bTurn;
  assert.ok(s1.log.some(l => l.text.includes('예 1 / 아니오 1 / 모호함 0')));

  // B 오답 → 패널티 → C 차례
  const cTurn = nextState(a, s => s.turnId === s.players[2].id);
  b.emit('guess', { text: '틀린답zz' });
  await cTurn;
  // C 질문 없이 오답 (패널티 적용) → A 차례
  const aTurn = nextState(a, s => s.turnId === s.players[0].id);
  c.emit('guess', { text: '틀린답zz' });
  await aTurn;
  // A 정답(공백 무시) → 1등, B 차례, B는 질문 불가
  const bTurn2 = nextState(b, s => s.turnId === s.players[1].id);
  a.emit('guess', { text: ` ${realA} ` });
  const s2 = await bTurn2;
  assert.equal(s2.players[0].rank, 1);
  assert.equal(s2.noAsk, true);
  const errP = wait(b, 'err');
  b.emit('ask', { text: '질문' });
  assert.match(await errP, /패널티/);

  // 관전자 A는 자기 제시어 보임
  const sA = await new Promise(r => { a.once('state', r); a.emit('ready'); });
  assert.equal(sA.players[0].word, realA);

  // B 정답 → 2명 맞힘, C 남음 → 종료
  const end = nextState(c, s => s.state === 'result');
  b.emit('guess', { text: realB });
  const r = await end;
  assert.deepEqual(r.players.map(p => p.rank), [1, 2, 3]);
  assert.deepEqual(r.players.map(p => p.score), [2, 1, 0], '누적 점수: 3명 중 1등 2점, 2등 1점');
  assert.equal(r.round, 1);
  assert.deepEqual(r.players.map(p => p.word), words.map((w, i) => i === 1 ? realB : w));

  // 끊긴 플레이어 턴은 건너뜀: 새 게임(A부터) → A 질문 → B·C 투표 → B 차례에 B 끊김 → C 차례
  const g2 = nextState(c, s => s.state === 'playing' && s.turnId);
  a.emit('again');
  await g2;
  a.emit('ask', { text: 'q' });
  await nextState(c, s => !!s.q);
  const bT = nextState(c, s => s.turnId === s.players[1].id);
  b.emit('vote', { answer: 'yes' }); c.emit('vote', { answer: 'yes' });
  await bT;
  const cT = nextState(c, s => s.turnId === s.players[2].id);
  b.disconnect();
  const s3 = await cT;
  assert.ok(s3.log.some(l => l.text.includes('기다립니다')));
  assert.ok(s3.log.some(l => l.text.includes('턴을 넘깁니다')));

  // C 질문 → (B 끊김, A만 투표) → A 차례, A 정답 → 1명 맞혀도 게임 계속, C 차례
  c.emit('ask', { text: 'q2' });
  await nextState(a, s => !!s.q);
  const aT = nextState(a, s => s.turnId === s.players[0].id);
  a.emit('vote', { answer: 'no' });
  await aT;
  const cT2 = nextState(a, s => s.turnId === s.players[2].id);
  a.emit('guess', { text: s3.players[0].word });
  const s4 = await cT2;
  assert.equal(s4.state, 'playing');
  assert.equal(s4.players[0].rank, 1);

  // 맞힌 A도 답변 가능(기본 설정): C 질문 → A 투표만으로 결과
  c.emit('ask', { text: 'q3' });
  await nextState(a, s => !!s.q);
  const back = nextState(a, s => !s.q && s.turnId === s.players[2].id);
  a.emit('vote', { answer: 'yes' });
  const s4b = await back;
  assert.ok(s4b.log.some(l => l.text.includes('예 1 / 아니오 0')), '관전자 투표 반영');

  // 남은 B·C 모두 끊김 → 종료가 아니라 대기, C 재접속 시 재개
  const paused = nextState(a, s => s.turnId === null);
  c.disconnect();
  const s5 = await paused;
  assert.equal(s5.state, 'playing');
  const c2 = mk(); await wait(c2, 'connect');
  const resumed = nextState(a, s => s.turnId === s.players[2].id);
  const rj = await emitCb(c2, 'join', { code, token: tok('c') });
  assert.equal(rj.code, code);
  await resumed;

  // 게임 중 강퇴: 강퇴된 사람은 퇴장 처리, 남은 미정답자 1명 → 종료
  const kicked = wait(c2, 'kicked');
  const over = nextState(a, s => s.state === 'result');
  a.emit('kick', { id: s5.players[2].id });
  await kicked;
  const s6 = await over;
  assert.equal(s6.players[2].rank, -1);
  assert.equal(s6.players[2].kicked, true);

  console.log('✅ all tests passed');
  [a, c2].forEach(s => s.close());
  process.exit(0);
});

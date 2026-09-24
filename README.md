# yangsechan

웹 기반 실시간 멀티플레이 **양세찬 게임** (Node.js + Socket.IO). 내 제시어만 나만 모르는 추리 게임, 2~8인.

## 로컬 실행

```bash
npm install
npm start      # http://localhost:3000
npm test       # 게임 흐름 자가 점검
```

## Render 배포

1. Render 대시보드 → **New → Blueprint** → 이 저장소 연결 (`render.yaml` 자동 인식)
2. 또는 **New → Web Service**: Build `npm ci`, Start `npm start`, Health Check `/healthz`

무료 플랜은 15분간 요청이 없으면 잠들어 첫 접속이 30초 정도 느릴 수 있습니다. 방 정보는 메모리에 저장되므로 서버가 재시작되면 초기화됩니다.

## 구성

- `server.js` — 게임 서버 (방·턴·투표·순위·재접속)
- `public/index.html` — 클라이언트
- `words.json` — 카테고리별 제시어

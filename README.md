# 양세찬 게임

모두가 아는 내 제시어, **나만 모른다!** 2–8인 실시간 온라인 추리 파티 게임입니다.
예/아니오 질문으로 내 이마의 제시어를 좁혀 가고, 먼저 맞힐수록 높은 등수를 받습니다.

- **바로 하기 (웹)**: https://yangsechan.onrender.com
- **앱 다운로드 (안드로이드 APK · 윈도우 EXE)**: [Releases](https://github.com/anaf-4/yangsechan/releases/latest)

## 주요 기능

- 공개방 목록 / 비공개방 6자리 코드, 초대 링크·공유, 게임 중 관전 입장
- 제시어 9개 카테고리 827개 + 직접 입력 + 서로 지정(작성자 무작위 배정)
- 질문 → 예·아니오·모호함 투표, 정답 도전(오답 패널티, 한 글자 차이면 "아까워요")
- 힌트(질문 5번마다: 글자 수 → 한 글자 초성 → 한 글자 공개), 질문 추천, 내 질문 기록, 패스
- 리액션·채팅(스포·욕설 자동 가림), 대기실 채팅, 효과음·진동
- 누적 점수판, 정답 공개 연출, 내 전적, 캐릭터(색·아이콘) 고르기
- 방장: 설정, 강퇴(재입장 차단), 방장 넘기기

## 구조

| 경로 | 내용 |
|---|---|
| `server.js` | 게임 서버 (Node.js + Socket.IO). 방은 메모리에만 저장 |
| `public/index.html` | 클라이언트 전체 (HTML·CSS·JS 한 파일) |
| `public/sfx/`, `public/*.png` | 효과음, 아이콘·링크 미리보기 이미지 |
| `words.json` | 카테고리별 제시어와 정답으로 인정할 별칭 |
| `test.js` | 게임 규칙 자동 테스트 (`npm test`) |
| `app/` | PC·안드로이드 앱 (배포된 사이트를 여는 래퍼: Electron, Capacitor) |
| `.github/workflows/` | `test.yml` 테스트, `app.yml` 앱 빌드·릴리스 |

## 로컬 실행

```bash
npm install
npm start      # http://localhost:3000
npm test
```

## 배포 (Render)

- Web Service · Build `npm install` · Start `node server.js` · Health Check `/healthz`
- 무료 플랜은 15분간 접속이 없으면 잠들고, 첫 접속에 최대 1분 걸립니다.
- 배포(재시작) 때 진행 중인 방은 사라집니다. 접속자에게는 안내가 표시됩니다.
- **Settings → Build & Deploy → Auto-Deploy**를 `After CI Checks Pass`로 두면 테스트 통과 후에만 배포됩니다.

## 앱 빌드·릴리스

- `app/` 폴더가 바뀌어 main에 푸시되면 APK·EXE가 빌드됩니다 (Actions → Artifacts).
- 새 버전 공개: `app/package.json`의 `version`을 올린 뒤 `vX.Y.Z` 태그를 푸시하면 Releases에 파일이 올라갑니다.
- 사이트만 바뀐 경우 앱은 다시 설치할 필요가 없습니다 (앱이 사이트를 그대로 엽니다).

### ⚠️ 안드로이드 서명 키

APK는 저장소 Secrets(`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`)의 고정 키로 서명됩니다.
원본 키 파일은 저장소 밖에 보관하고 **반드시 백업**하세요. 잃어버리면 기존 사용자에게 업데이트를 배포할 수 없습니다.

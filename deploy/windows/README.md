# 윈도우 서버컴에 양세찬 게임 올리기 (yangsechan.kr)

구성: **서버컴(게임 서버, 윈도우 서비스)** ← Cloudflare Tunnel ← **https://yangsechan.kr**
- 공유기 포트포워딩, 인증서(HTTPS) 설정이 필요 없습니다. 집 IP가 바뀌어도, 외부에 IP가 드러나지 않아도 됩니다.
- 앱(PC·안드로이드)은 yangsechan.kr에 먼저 접속하고, 안 되면 예비 서버(Render)로 접속합니다.

---

## 1단계. 도메인을 Cloudflare에 연결 (한 번만)

1. https://dash.cloudflare.com 에 가입 → **Add a domain(도메인 추가)** → `yangsechan.kr` 입력 → **Free** 플랜 선택
2. Cloudflare가 알려 주는 **네임서버 2개**(예: `xxx.ns.cloudflare.com`)를 복사
3. 도메인을 산 곳(가비아, 후이즈 등)의 도메인 관리 → **네임서버 변경** → 기존 것을 지우고 위 2개로 바꿔 저장
4. Cloudflare 화면에 도메인이 **Active**로 바뀔 때까지 기다리기 (보통 수 분 ~ 몇 시간, 최대 24시간)

## 2단계. 서버컴에 게임 서버 설치

서버컴에서 **시작 → PowerShell 우클릭 → 관리자 권한으로 실행** 후 아래 두 줄을 붙여넣기:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://raw.githubusercontent.com/anaf-4/yangsechan/main/deploy/windows/install.ps1 -OutFile $env:TEMP\ysc-install.ps1; & $env:TEMP\ysc-install.ps1
```

Node.js·Git을 확인(없으면 설치)하고, `C:\yangsechan`에 게임을 받아 **"양세찬 게임 서버"** 윈도우 서비스로 등록합니다.
마지막에 `서버 정상 동작: http://localhost:3000` 이 초록색으로 나오면 성공입니다. (서버컴 브라우저로 열어 봐도 됩니다)

- 컴퓨터를 켜면 자동으로 시작되고, 오류로 꺼져도 3초 뒤 자동으로 다시 켜집니다.
- 로그: `C:\yangsechan\logs\`

## 3단계. Cloudflare Tunnel로 yangsechan.kr 연결

1. https://one.dash.cloudflare.com (Zero Trust) → **Networks → Tunnels → Create a tunnel**
2. **Cloudflared** 선택 → 이름 `yangsechan` → 저장
3. 운영체제 **Windows** 선택 → 화면에 나오는 설치 명령(`cloudflared.exe service install eyJ...` 처럼 긴 토큰이 붙은 것)을 복사
4. 서버컴 관리자 PowerShell에서:
   ```powershell
   winget install --id Cloudflare.cloudflared -e
   ```
   PowerShell을 **새로 연 뒤**(관리자 권한) 3번에서 복사한 명령을 붙여넣어 실행 → Cloudflare 화면에 연결됨(Healthy) 표시
5. **Public Hostname(공개 호스트 이름)** 추가:
   - Subdomain: *(비워 두기)* · Domain: `yangsechan.kr`
   - Service: Type `HTTP` · URL `localhost:3000`
   - 저장 (`www.yangsechan.kr`도 쓰려면 Subdomain에 `www`로 하나 더 추가)

## 4단계. 확인

- 휴대폰(와이파이 끄고 LTE)으로 **https://yangsechan.kr** 접속 → 게임 첫 화면이 나오면 완료
- https://yangsechan.kr/healthz → `ok`

---

# 서버컴 혼자서 다 하기 (GitHub 없이)

| 할 일 | 어디서 |
|---|---|
| 코드 보관 | **https://git.yangsechan.kr** (서버컴의 Gitea, 로그인한 사람만 볼 수 있음) |
| 자동 테스트 | 서버컴이 새 버전을 받으면 직접 `npm test` |
| 서버 업데이트 | 테스트 통과 + **접속자 0명**일 때 자동 |
| 앱 빌드 | 새 버전 태그(`v1.x.x`)가 올라오면 서버컴이 APK·EXE를 직접 빌드 |
| 앱 다운로드 | **https://yangsechan.kr/download** |

## 5단계. Cloudflare에 git.yangsechan.kr 추가

Zero Trust → Networks → Tunnels → `yangsechan` → **Public Hostname 추가**
- Subdomain: `git` · Domain: `yangsechan.kr` · Service: `HTTP` · URL `localhost:3001`

## 6단계. 최신 스크립트 받기 + Gitea 설치

서버컴 관리자 PowerShell에서 (한 줄씩):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
C:\yangsechan\deploy\windows\update.ps1
C:\yangsechan\deploy\windows\install-gitea.ps1
C:\yangsechan\deploy\windows\install.ps1
```

- `update.ps1`: GitHub에서 마지막으로 새 스크립트를 받아 옵니다. (이후로는 GitHub을 쓰지 않습니다)
- `install-gitea.ps1`: Gitea를 설치하고 **아이디·이메일·비밀번호를 물어봅니다** (직접 정해 입력). 서버컴의 코드를 Gitea로 옮기고, 게임 서버가 앞으로 Gitea에서 업데이트를 받도록 바꿉니다.
- `install.ps1`: 자동 업데이트(5분마다)를 새 설정으로 등록합니다.
- 브라우저로 https://git.yangsechan.kr 에 들어가 방금 만든 아이디로 로그인되면 성공입니다.

## 7단계. 앱 빌드 준비 (한 번만)

1. 개발 PC의 `E:\양세찬게임-서명키` 폴더에 있는 두 파일을 **USB 등으로** 서버컴의 `C:\yangsechan-signing\` 폴더에 복사
   (`yangsechan-release.jks`, `서명키 정보.txt` — 인터넷·메신저로 보내지 마세요)
2. 서버컴 관리자 PowerShell에서:
   ```powershell
   C:\yangsechan\deploy\windows\setup-build.ps1
   ```
   Java와 안드로이드 SDK를 설치합니다 (1~2GB, 시간이 좀 걸려요).
3. 준비가 끝나면 5분 안에 자동 업데이트가 최신 태그(v1.3.0)의 앱을 빌드해 **https://yangsechan.kr/download** 에 올립니다.
   첫 빌드는 도구를 내려받느라 20~30분 걸릴 수 있습니다.

---

## 평소 운영

- **자동으로 다 됩니다.** 기록은 `C:\yangsechan\logs\auto-update.log` 에서 볼 수 있어요.
- 새 코드가 올라오면: 테스트 → 통과하고 접속자가 없을 때 업데이트 (게임 중에는 기다림)
- 새 버전 태그가 올라오면: 앱 빌드 → 다운로드 페이지에 공개 (빌드 기록: `logs\build-v1.x.x.log`)
- 자동 업데이트 끄기/켜기: `Disable-ScheduledTask 'Yangsechan AutoUpdate'` / `Enable-ScheduledTask 'Yangsechan AutoUpdate'`
- 지금 바로 업데이트(수동): `C:\yangsechan\deploy\windows\update.ps1` (진행 중인 방은 사라짐)
- 앱 다시 빌드(수동): `C:\yangsechan\deploy\windows\build-apps.ps1 -Tag v1.3.0`

## 서버컴 관리 팁

- **절전 끄기**: 설정 → 시스템 → 전원 → 화면·절전을 **"안 함"**으로 (절전되면 게임이 끊깁니다)
- **윈도우 업데이트 재시작**: 설정 → Windows 업데이트 → 고급 옵션 → **사용 시간**을 게임이 많은 시간대로 지정
- 서비스 상태 보기/재시작: `services.msc` → "양세찬 게임 서버", 또는 관리자 PowerShell에서 `Restart-Service Yangsechan`
- 서버 끄기: `Stop-Service Yangsechan` · 다시 켜기: `Start-Service Yangsechan`
- 서비스 실행기(WinSW)와 설정 파일은 `C:\yangsechan-service\`에 있습니다

## 예비 서버 (Render)

Render 서버는 그대로 두면 **예비 서버**로 쓰입니다. 서버컴이 꺼져 있을 때 앱이 자동으로 Render에 연결합니다.
(단, 두 서버는 방이 서로 따로입니다. 친구와 같은 주소로 들어가야 같은 방에서 만날 수 있어요. 초대 링크는 자동으로 같은 주소를 씁니다.)

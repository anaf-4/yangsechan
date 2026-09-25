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

## 서버 업데이트 (코드가 바뀌었을 때)

서버컴 관리자 PowerShell에서:

```powershell
C:\yangsechan\deploy\windows\update.ps1
```

GitHub에서 최신 코드를 받아 서버를 다시 켭니다. **진행 중인 방은 사라지니** 게임하는 사람이 없을 때 실행하세요. (접속자에게는 "서버 업데이트 중" 안내가 뜹니다)

## 서버컴 관리 팁

- **절전 끄기**: 설정 → 시스템 → 전원 → 화면·절전을 **"안 함"**으로 (절전되면 게임이 끊깁니다)
- **윈도우 업데이트 재시작**: 설정 → Windows 업데이트 → 고급 옵션 → **사용 시간**을 게임이 많은 시간대로 지정
- 서비스 상태 보기/재시작: `services.msc` → "양세찬 게임 서버", 또는 관리자 PowerShell에서 `Restart-Service Yangsechan`
- 서버 끄기: `Stop-Service Yangsechan` · 다시 켜기: `Start-Service Yangsechan`
- 서비스 실행기(WinSW)와 설정 파일은 `C:\yangsechan-service\`에 있습니다

## 예비 서버 (Render)

Render 서버는 그대로 두면 **예비 서버**로 쓰입니다. 서버컴이 꺼져 있을 때 앱이 자동으로 Render에 연결합니다.
(단, 두 서버는 방이 서로 따로입니다. 친구와 같은 주소로 들어가야 같은 방에서 만날 수 있어요. 초대 링크는 자동으로 같은 주소를 씁니다.)

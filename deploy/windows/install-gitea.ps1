# 서버컴에 Gitea(직접 운영하는 GitHub 같은 코드 저장소) 설치 → https://git.yangsechan.kr
# 사용법: 관리자 PowerShell에서
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   C:\yangsechan\deploy\windows\install-gitea.ps1
# 하는 일:
#   1) Gitea 설치 (C:\gitea, 포트 3001, 서버컴 안에서만 접속 → 밖에서는 Cloudflare로 git.yangsechan.kr)
#   2) 관리자 계정 만들기 (아이디·비밀번호는 실행 중에 직접 입력)
#   3) 코드 저장소 yangsechan 만들고, 서버컴에 있는 게임 코드를 올림
#   4) 게임 서버(C:\yangsechan)가 앞으로 GitHub 대신 이 Gitea에서 업데이트를 받도록 변경
# 다시 실행해도 안전합니다.

$ErrorActionPreference = 'Stop'
$Root    = 'C:\gitea'
$Port    = 3001
$Ver     = '1.27.3'
$Domain  = 'git.yangsechan.kr'
$Game    = 'C:\yangsechan'
$Service = 'Gitea'
$WinSW   = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

function Say($m) { Write-Host "`n▶ $m" -ForegroundColor Yellow }
function Native($what) { if ($LASTEXITCODE) { throw "$what 실패 (코드 $LASTEXITCODE)" } }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '관리자 권한 PowerShell에서 실행해 주세요.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Say "Gitea $Ver 설치 → $Root"
New-Item -ItemType Directory -Force "$Root\custom\conf", "$Root\data", "$Root\log" | Out-Null
$exe = "$Root\gitea.exe"
if (-not (Test-Path $exe)) {
  Write-Host '  Gitea 받는 중… (약 100MB)'
  Invoke-WebRequest "https://dl.gitea.com/gitea/$Ver/gitea-$Ver-windows-4.0-amd64.exe" -OutFile $exe -UseBasicParsing
}
$ini = "$Root\custom\conf\app.ini"
$paths = @('--config', $ini, '--work-path', $Root)
if (-not (Test-Path $ini)) {
  $secret = (& $exe generate secret SECRET_KEY).Trim()
  $internal = (& $exe generate secret INTERNAL_TOKEN).Trim()
  $jwt = (& $exe generate secret JWT_SECRET).Trim()
  $r = $Root.Replace('\', '/')
  $conf = @"
APP_NAME = 양세찬 게임 코드 저장소
RUN_MODE = prod
RUN_USER = $env:COMPUTERNAME`$
WORK_PATH = $r

[server]
PROTOCOL = http
HTTP_ADDR = 127.0.0.1
HTTP_PORT = $Port
DOMAIN = $Domain
ROOT_URL = https://$Domain/
DISABLE_SSH = true
LFS_START_SERVER = false
OFFLINE_MODE = true
LANDING_PAGE = login

[database]
DB_TYPE = sqlite3
PATH = $r/data/gitea.db

[repository]
ROOT = $r/data/repos
DEFAULT_PRIVATE = private
DEFAULT_BRANCH = main

[security]
INSTALL_LOCK = true
SECRET_KEY = $secret
INTERNAL_TOKEN = $internal
LOGIN_REMEMBER_DAYS = 30

[oauth2]
JWT_SECRET = $jwt

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
ENABLE_NOTIFY_MAIL = false

[openid]
ENABLE_OPENID_SIGNIN = false
ENABLE_OPENID_SIGNUP = false

[mailer]
ENABLED = false

[actions]
ENABLED = false

[log]
MODE = file
LEVEL = Info
ROOT_PATH = $r/log
"@
  [IO.File]::WriteAllText($ini, $conf, [Text.UTF8Encoding]::new($false))
  Write-Host '  설정 파일 생성'
}

Say "Gitea 윈도우 서비스 등록 ($Service)"
$svcExe = "$Root\$Service-service.exe"
if (-not (Test-Path $svcExe)) { Invoke-WebRequest $WinSW -OutFile $svcExe -UseBasicParsing }
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<service>
  <id>$Service</id>
  <name>양세찬 코드 저장소 (Gitea)</name>
  <description>Gitea - https://$Domain (포트 $Port)</description>
  <executable>$exe</executable>
  <arguments>web --config "$ini" --work-path "$Root"</arguments>
  <workingdirectory>$Root</workingdirectory>
  <env name="GITEA_WORK_DIR" value="$Root" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec" />
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$Root\log</logpath>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
[IO.File]::WriteAllText("$Root\$Service-service.xml", $xml, [Text.UTF8Encoding]::new($false))
if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) { & $svcExe install | Out-Null }
Restart-Service $Service
$api = "http://127.0.0.1:$Port"
for ($i = 0; $i -lt 30; $i++) { try { Invoke-WebRequest "$api/api/healthz" -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep 2 } }
Write-Host "  Gitea 동작 중: $api" -ForegroundColor Green

Say '관리자 계정'
$user = Read-Host '  Gitea 아이디 (영문·숫자, 엔터 = anaf)'
if (-not $user) { $user = 'anaf' }
$exists = (& $exe admin user list --admin @paths) -match "\s$user\s"
if (-not $exists) {
  $email = Read-Host '  이메일 (로그인 복구용, 아무 주소나 가능)'
  do {
    $p1 = Read-Host '  비밀번호 (8자 이상)' -AsSecureString
    $p2 = Read-Host '  비밀번호 확인' -AsSecureString
    $a = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
    $b = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($a -ne $b -or $a.Length -lt 8) { Write-Host '  두 비밀번호가 다르거나 8자 미만입니다. 다시 입력해 주세요.' -ForegroundColor Red }
  } until ($a -eq $b -and $a.Length -ge 8)
  & $exe admin user create --admin --username $user --email $email --password $a --must-change-password=false @paths | Out-Null; Native '계정 만들기'
  $a = $b = $null
  Write-Host "  계정 생성: $user" -ForegroundColor Green
} else { Write-Host "  이미 있는 계정: $user" }

Say '서버컴용 접근 토큰 (서버컴 안에서만 사용)'
$tokenName = "server-$(Get-Date -Format yyyyMMddHHmmss)"
$token = (& $exe admin user generate-access-token --username $user --token-name $tokenName --scopes write:repository,write:user --raw @paths | Select-Object -Last 1).Trim(); Native '토큰 만들기'

Say '코드 저장소 yangsechan 만들기'
$h = @{ Authorization = "token $token" }
try { Invoke-RestMethod "$api/api/v1/repos/$user/yangsechan" -Headers $h | Out-Null; Write-Host '  이미 있음' }
catch {
  Invoke-RestMethod "$api/api/v1/user/repos" -Method Post -Headers $h -ContentType 'application/json' `
    -Body (@{ name = 'yangsechan'; private = $true; default_branch = 'main'; description = '양세찬 게임' } | ConvertTo-Json) | Out-Null
  Write-Host '  생성됨' -ForegroundColor Green
}

Say "서버컴의 게임 코드를 Gitea로 올리고, 앞으로 Gitea에서 업데이트 받도록 변경"
$local = "http://${user}:$token@127.0.0.1:$Port/$user/yangsechan.git"
git -C $Game push $local HEAD:refs/heads/main --tags --force; Native 'git push'
git -C $Game remote set-url origin $local; Native 'remote 변경'
git -C $Game fetch --quiet origin; Native 'git fetch'
git -C $Game branch --set-upstream-to=origin/main | Out-Null

Say '완료!'
Write-Host @"
  - Gitea 주소(서버컴 안): $api   /   밖에서: https://$Domain  (Cloudflare에 git.yangsechan.kr → localhost:$Port 연결 필요)
  - 로그인 아이디: $user
  - 게임 서버는 이제 Gitea의 코드로 자동 업데이트됩니다.
"@ -ForegroundColor Green

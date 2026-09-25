# 양세찬 게임 서버 설치 (윈도우 서버컴용)
# 사용법: PowerShell을 "관리자 권한으로 실행" 후
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\install.ps1
# 하는 일: Node.js·Git 확인(없으면 설치) → 게임 코드 받기 → WinSW로 윈도우 서비스(Yangsechan) 등록·시작
# 다시 실행해도 안전합니다 (이미 있으면 건너뛰거나 최신으로 갱신).

$ErrorActionPreference = 'Stop'
$Dir     = 'C:\yangsechan'                                   # 게임 서버 코드
$SvcDir  = 'C:\yangsechan-service'                           # 서비스 실행기(WinSW)와 설정
$Repo    = 'https://github.com/anaf-4/yangsechan.git'
$Service = 'Yangsechan'
$Port    = 3000
$WinSW   = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

function Say($m) { Write-Host "`n▶ $m" -ForegroundColor Yellow }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}
function Ensure($cmd, $wingetId) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "  $cmd 이미 설치됨"; return }
  Say "$cmd 설치 ($wingetId)"
  winget install --id $wingetId -e --silent --source winget --accept-package-agreements --accept-source-agreements --scope machine
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd 설치 후에도 찾을 수 없습니다. PowerShell을 새로 열고 다시 실행해 주세요." }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '관리자 권한 PowerShell에서 실행해 주세요. (시작 → PowerShell 우클릭 → 관리자 권한으로 실행)'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Say '필요한 프로그램 확인'
Refresh-Path
Ensure node 'OpenJS.NodeJS.LTS'
Ensure git  'Git.Git'

Say "게임 코드 받기 → $Dir"
if (Test-Path "$Dir\.git") { git -C $Dir pull --ff-only }
else { git clone $Repo $Dir }

Say '패키지 설치'
Push-Location $Dir
npm ci --omit=dev
Pop-Location

Say "윈도우 서비스 준비 ($Service)"
New-Item -ItemType Directory -Force $SvcDir, "$Dir\logs" | Out-Null
$exe = "$SvcDir\$Service.exe"
if (-not (Test-Path $exe)) {
  Write-Host '  서비스 실행기(WinSW) 받는 중…'
  Invoke-WebRequest $WinSW -OutFile $exe -UseBasicParsing
}
$node = (Get-Command node).Source
# 서비스 설정: 부팅 시 자동 시작, 꺼지면 3초 뒤 자동 재시작, 종료 시 Ctrl+C로 접속자에게 안내할 시간 5초, 로그 5MB씩 5개 보관
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<service>
  <id>$Service</id>
  <name>양세찬 게임 서버</name>
  <description>양세찬 게임 온라인 서버 (Node.js, 포트 $Port)</description>
  <executable>$node</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$Dir</workingdirectory>
  <env name="PORT" value="$Port" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="3 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>5 sec</stoptimeout>
  <logpath>$Dir\logs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>5120</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
[IO.File]::WriteAllText("$SvcDir\$Service.xml", $xml, [Text.UTF8Encoding]::new($false))

if (Get-Service $Service -ErrorAction SilentlyContinue) {
  Write-Host '  기존 서비스 설정 갱신'
  Stop-Service $Service -ErrorAction SilentlyContinue
  & $exe uninstall | Out-Null
  Start-Sleep -Seconds 2
}
& $exe install | Out-Null
Start-Service $Service

Say '동작 확인'
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest "http://localhost:$Port/healthz" -UseBasicParsing -TimeoutSec 5
  Write-Host "  서버 정상 동작: http://localhost:$Port  (healthz → $($r.Content))" -ForegroundColor Green
} catch {
  Write-Host "  서버 응답이 없습니다. $Dir\logs 폴더의 로그를 확인해 주세요." -ForegroundColor Red
}

Say '다음 단계: Cloudflare Tunnel 연결 (deploy\windows\README.md 3단계)'

# 양세찬 게임 서버 설치 (윈도우 서버컴용)
# 사용법: PowerShell을 "관리자 권한으로 실행" 후
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\install.ps1
# 하는 일: Node.js·Git·NSSM 설치 → 게임 코드 받기 → 윈도우 서비스(Yangsechan) 등록·시작
# 다시 실행해도 안전합니다 (이미 있으면 건너뜀).

$ErrorActionPreference = 'Stop'
$Dir     = 'C:\yangsechan'                                  # 게임 서버 설치 위치
$Repo    = 'https://github.com/anaf-4/yangsechan.git'
$Service = 'Yangsechan'
$Port    = 3000

function Say($m) { Write-Host "`n▶ $m" -ForegroundColor Yellow }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}
function Ensure($cmd, $wingetId) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "  $cmd 이미 설치됨"; return }
  Say "$cmd 설치 ($wingetId)"
  winget install --id $wingetId -e --silent --accept-package-agreements --accept-source-agreements --scope machine
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd 설치 후에도 찾을 수 없습니다. PowerShell을 새로 열고 다시 실행해 주세요." }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '관리자 권한 PowerShell에서 실행해 주세요. (시작 → PowerShell 우클릭 → 관리자 권한으로 실행)'
}

Say '필요한 프로그램 확인'
Refresh-Path
Ensure node 'OpenJS.NodeJS.LTS'
Ensure git  'Git.Git'
Ensure nssm 'NSSM.NSSM'

Say "게임 코드 받기 → $Dir"
if (Test-Path "$Dir\.git") { git -C $Dir pull --ff-only }
else { git clone $Repo $Dir }

Say '패키지 설치'
Push-Location $Dir
npm ci --omit=dev
Pop-Location

Say "윈도우 서비스 등록 ($Service)"
$node = (Get-Command node).Source
if (Get-Service $Service -ErrorAction SilentlyContinue) { nssm stop $Service | Out-Null }
else { nssm install $Service $node 'server.js' | Out-Null }
nssm set $Service Application $node | Out-Null
nssm set $Service AppParameters 'server.js' | Out-Null
nssm set $Service AppDirectory $Dir | Out-Null
nssm set $Service AppEnvironmentExtra "PORT=$Port" | Out-Null
nssm set $Service DisplayName '양세찬 게임 서버' | Out-Null
nssm set $Service Start SERVICE_AUTO_START | Out-Null          # 컴퓨터가 켜지면 자동 시작
nssm set $Service AppExit Default Restart | Out-Null            # 꺼지면 자동 재시작
nssm set $Service AppRestartDelay 3000 | Out-Null
nssm set $Service AppStopMethodConsole 3000 | Out-Null          # 종료 시 Ctrl+C로 접속자에게 안내할 시간
New-Item -ItemType Directory -Force "$Dir\logs" | Out-Null
nssm set $Service AppStdout "$Dir\logs\server.log" | Out-Null
nssm set $Service AppStderr "$Dir\logs\error.log" | Out-Null
nssm set $Service AppRotateFiles 1 | Out-Null
nssm set $Service AppRotateBytes 5000000 | Out-Null
nssm start $Service | Out-Null

Say '동작 확인'
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest "http://localhost:$Port/healthz" -UseBasicParsing -TimeoutSec 5
  Write-Host "  서버 정상 동작: http://localhost:$Port  (healthz → $($r.Content))" -ForegroundColor Green
} catch {
  Write-Host "  서버 응답이 없습니다. $Dir\logs\error.log 를 확인해 주세요." -ForegroundColor Red
}

Say '다음 단계: Cloudflare Tunnel 연결 (deploy\windows\README.md 3단계)'

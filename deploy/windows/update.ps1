# 양세찬 게임 서버 업데이트 (GitHub의 최신 코드로)
# 사용법: 관리자 권한 PowerShell에서  C:\yangsechan\deploy\windows\update.ps1
# 주의: 서버가 다시 켜지면서 진행 중인 방은 사라집니다. 접속자에게는 "서버 업데이트 중" 안내가 뜹니다.

$ErrorActionPreference = 'Stop'
$Dir = 'C:\yangsechan'
$Service = 'Yangsechan'

$before = git -C $Dir rev-parse HEAD
git -C $Dir pull --ff-only
$after = git -C $Dir rev-parse HEAD
if ($before -eq $after) { Write-Host '이미 최신 버전입니다.' -ForegroundColor Green; exit 0 }

Push-Location $Dir
npm ci --omit=dev
Pop-Location

nssm restart $Service | Out-Null
Start-Sleep -Seconds 3
$r = Invoke-WebRequest 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 5
Write-Host "업데이트 완료: $($before.Substring(0,7)) → $($after.Substring(0,7))  (healthz → $($r.Content))" -ForegroundColor Green
git -C $Dir log --oneline "$before..$after"

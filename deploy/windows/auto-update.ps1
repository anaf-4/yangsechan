# 양세찬 게임 서버 자동 업데이트·앱 빌드 (작업 스케줄러가 5분마다 실행)
#  1) 코드 저장소(Gitea)에 새 버전 → 서버컴이 직접 테스트 → 통과 + 접속자 0명이면 update.ps1로 업데이트
#  2) 새 버전 태그(v1.x.x) → build-apps.ps1로 APK·EXE 빌드 → https://yangsechan.kr/download 에 공개
# 기록: C:\yangsechan\logs\auto-update.log
# 끄기: 관리자 PowerShell에서  Disable-ScheduledTask 'Yangsechan AutoUpdate'   (다시 켜기: Enable-ScheduledTask)
# 시험: .\auto-update.ps1 -DryRun   (테스트까지만 하고 업데이트·빌드는 하지 않음)

param(
  [string]$Dir = 'C:\yangsechan',
  [int]$Port = 3000,
  [string]$TestDir = 'C:\yangsechan-test',
  [string]$Downloads = 'C:\yangsechan-downloads',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Log       = "$Dir\logs\auto-update.log"
$State     = "$Dir\logs\auto-update.state.json"
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
New-Item -ItemType Directory -Force "$Dir\logs" | Out-Null

function Log($m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Add-Content -Path $Log -Value $line -Encoding UTF8
  Write-Host $line
}
# 상태: 테스트 결과를 기억해 같은 버전을 5분마다 다시 테스트하지 않고, 같은 안내가 반복 기록되지 않게 함
$st = @{ tested = @{}; said = '' }
if (Test-Path $State) { try { $j = Get-Content $State -Raw | ConvertFrom-Json; $j.tested.PSObject.Properties | ForEach-Object { $st.tested[$_.Name] = $_.Value }; $st.said = $j.said } catch {} }
function Save { $st | ConvertTo-Json -Depth 3 | Set-Content $State -Encoding UTF8 }
function Say1($key, $m) { if ($st.said -ne $key) { Log $m; $st.said = $key; Save } }

function Test-Version($sha) {
  # 서버컴에서 직접 자동 테스트(npm test) — 게임 서버와 별도 폴더에서
  $url = (git -C $Dir remote get-url origin).Trim()
  if (-not (Test-Path "$TestDir\.git")) { git clone --quiet $url $TestDir } else { git -C $TestDir remote set-url origin $url }
  git -C $TestDir fetch --quiet origin
  git -C $TestDir checkout --quiet --force $sha
  Push-Location $TestDir
  try {
    npm ci --no-fund --no-audit *> "$Dir\logs\auto-update.test.log"
    if ($LASTEXITCODE) { return $false }
    npm test *>> "$Dir\logs\auto-update.test.log"
    return ($LASTEXITCODE -eq 0)
  } finally { Pop-Location }
}

try {
  git -C $Dir fetch --quiet --tags --force origin
  if ($LASTEXITCODE) { throw '코드 저장소(Gitea)에 연결하지 못했습니다' }

  # ---------- 1) 게임 서버 업데이트 ----------
  $local  = (git -C $Dir rev-parse HEAD).Trim()
  $remote = (git -C $Dir rev-parse origin/main).Trim()
  if ($local -ne $remote) {
    $short = $remote.Substring(0, 7)
    if (-not $st.tested.ContainsKey($remote)) {
      Log "새 버전 $short : 테스트 실행 중…"
      $st.tested[$remote] = Test-Version $remote
      Save
      Log ("새 버전 $short : 테스트 " + $(if ($st.tested[$remote]) { '통과' } else { "실패 → 업데이트하지 않음 (자세한 내용: $Dir\logs\auto-update.test.log)" }))
    }
    if ($st.tested[$remote]) {
      $online = 0
      try { $online = (Invoke-RestMethod "http://localhost:$Port/status" -TimeoutSec 5).online } catch {}
      if ($online -gt 0) { Say1 "$remote|busy" "새 버전 $short : 접속자 ${online}명 → 모두 나가면 업데이트" }
      elseif ($DryRun) { Write-Host "새 버전 $short : 테스트 통과, 접속자 0명 → 지금 업데이트 가능 (DryRun)" }
      else {
        Log "새 버전 $short : 업데이트 시작"
        & "$Dir\deploy\windows\update.ps1" *>&1 | ForEach-Object { Log "  $_" }
        Log "업데이트 완료 → $short"
        $st.said = "$remote|done"; Save
      }
    }
  }

  # ---------- 2) 새 버전 태그 → 앱 빌드 ----------
  $latest = git -C $Dir tag -l 'v*' | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
  if ($latest -and -not (Test-Path "$Downloads\$latest") -and -not $st.tested.ContainsKey("build:$latest")) {
    $ready = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine') -and (Test-Path 'C:\yangsechan-signing\yangsechan-release.jks')
    if (-not $ready) { Say1 "$latest|notready" "새 태그 $latest : 앱 빌드 준비 안 됨 (setup-build.ps1 실행·서명 키 복사 필요)" }
    elseif ($DryRun) { Write-Host "새 태그 $latest : 앱 빌드 예정 (DryRun)" }
    else {
      Log "새 태그 $latest : 앱 빌드 시작 (10~30분)"
      try { & "$Dir\deploy\windows\build-apps.ps1" -Tag $latest *> "$Dir\logs\build-$latest.log" } catch { Add-Content "$Dir\logs\build-$latest.log" "오류: $($_.Exception.Message)" }
      # 실패해도 자동으로 다시 시도하지 않음 (빌드가 오래 걸려서). 고친 뒤 수동으로: build-apps.ps1 -Tag
      $st.tested["build:$latest"] = [bool](Test-Path "$Downloads\$latest"); Save
      if ($st.tested["build:$latest"]) { Log "새 태그 $latest : 앱 빌드 완료 → https://yangsechan.kr/download" }
      else { Log "새 태그 $latest : 앱 빌드 실패 (자세한 내용: $Dir\logs\build-$latest.log) — 고친 뒤 build-apps.ps1 -Tag $latest 로 다시 실행" }
    }
  }
} catch {
  Say1 "error|$($_.Exception.Message)" "오류: $($_.Exception.Message)"
  exit 1
}

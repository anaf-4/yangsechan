# 서버컴에서 앱(APK·EXE)을 빌드할 수 있게 준비 (한 번만)
# 사용법: 관리자 PowerShell에서  C:\yangsechan\deploy\windows\setup-build.ps1
# 하는 일: Java(JDK 21) 설치, 안드로이드 SDK(C:\android-sdk) 설치·라이선스 동의, 서명 키 위치 확인
# 약 1~2GB를 내려받으니 시간이 좀 걸립니다. 다시 실행해도 안전합니다.

$ErrorActionPreference = 'Stop'
$Sdk  = 'C:\android-sdk'
$Sign = 'C:\yangsechan-signing'
$CmdlineTools = 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'

function Say($m) { Write-Host "`n▶ $m" -ForegroundColor Yellow }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '관리자 권한 PowerShell에서 실행해 주세요.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Say 'Java (JDK 21)'
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
if (-not $jdk) {
  winget install --id Microsoft.OpenJDK.21 -e --silent --source winget --accept-package-agreements --accept-source-agreements --scope machine
  $jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' | Sort-Object Name | Select-Object -Last 1
}
if (-not $jdk) { throw 'JDK 21 설치를 확인할 수 없습니다.' }
[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk.FullName, 'Machine')
$env:JAVA_HOME = $jdk.FullName
Write-Host "  JAVA_HOME = $($jdk.FullName)" -ForegroundColor Green

Say "안드로이드 SDK → $Sdk"
$sdkm = "$Sdk\cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path $sdkm)) {
  $zip = "$env:TEMP\android-cmdline-tools.zip"
  Write-Host '  명령줄 도구 받는 중…'
  Invoke-WebRequest $CmdlineTools -OutFile $zip -UseBasicParsing
  $tmp = "$env:TEMP\android-cmdline-tools"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force "$Sdk\cmdline-tools" | Out-Null
  Move-Item "$tmp\cmdline-tools" "$Sdk\cmdline-tools\latest"
}
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $Sdk, 'Machine')
$env:ANDROID_HOME = $Sdk
Write-Host '  라이선스 동의 중…'
('y' + [Environment]::NewLine) * 40 | & $sdkm --sdk_root=$Sdk --licenses | Out-Null
Write-Host '  플랫폼·빌드 도구 설치 중… (몇 분 걸려요)'
& $sdkm --sdk_root=$Sdk 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' | Out-Null
if ($LASTEXITCODE) { throw 'SDK 구성요소 설치 실패' }
Write-Host "  ANDROID_HOME = $Sdk" -ForegroundColor Green

Say "서명 키 확인 → $Sign"
New-Item -ItemType Directory -Force $Sign | Out-Null
$ok = (Test-Path "$Sign\yangsechan-release.jks") -and (Test-Path "$Sign\서명키 정보.txt")
if ($ok) {
  # 관리자와 SYSTEM(자동 빌드)만 읽을 수 있게
  icacls $Sign /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
  Write-Host '  서명 키 있음 (관리자·SYSTEM만 접근 가능하게 잠금)' -ForegroundColor Green
} else {
  Write-Host @"
  서명 키가 아직 없습니다. 개발 PC의 E:\양세찬게임-서명키 폴더에 있는 두 파일을
  USB 등으로 서버컴의 $Sign 폴더에 복사한 뒤, 이 스크립트를 한 번 더 실행해 주세요.
    - yangsechan-release.jks
    - 서명키 정보.txt
  (인터넷·메신저로 보내지 마세요. 이 키가 새면 누구나 우리 앱인 척 업데이트를 만들 수 있습니다.)
"@ -ForegroundColor Red
}

Say '준비 완료 — 새 버전 태그(v1.x.x)가 올라오면 자동 업데이트가 앱을 빌드해 https://yangsechan.kr/download 에 올립니다.'

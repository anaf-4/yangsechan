# 서버컴에서 앱 빌드: 태그(v1.x.x)의 코드로 EXE(설치·설치 없이·스토브 zip)와 서명된 APK를 만들어
# C:\yangsechan-downloads\<태그>\ 에 넣음 → https://yangsechan.kr/download 에 바로 나타남
# 사용법: 관리자 PowerShell에서  C:\yangsechan\deploy\windows\build-apps.ps1 -Tag v1.3.0
# (보통은 auto-update.ps1이 새 태그를 발견하면 자동으로 실행합니다)

param([Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag)
$ErrorActionPreference = 'Stop'
$Game  = 'C:\yangsechan'
$Build = 'C:\yangsechan-build'
$Out   = "C:\yangsechan-downloads\$Tag"
$Sign  = 'C:\yangsechan-signing'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$env:JAVA_HOME = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')
$env:ANDROID_HOME = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'Machine')
$env:CI = 'true'   # 빌드 도구의 대화형 질문 끄기

function Step($m) { Write-Host "`n▶ $m" -ForegroundColor Yellow }
function Run([scriptblock]$cmd, $what) { & $cmd; if ($LASTEXITCODE) { throw "$what 실패 (코드 $LASTEXITCODE)" } }

# 준비물 확인
if (-not $env:JAVA_HOME -or -not $env:ANDROID_HOME) { throw 'Java/안드로이드 SDK가 없습니다. setup-build.ps1을 먼저 실행해 주세요.' }
if (-not (Test-Path "$Sign\yangsechan-release.jks")) { throw "서명 키가 없습니다: $Sign\yangsechan-release.jks" }
$pw = ((Get-Content "$Sign\서명키 정보.txt" -Encoding UTF8 | Select-String '비밀번호').ToString() -split ':\s*', 2)[1].Split(' ')[0].Trim()
$buildTools = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object { [version]$_.Name } | Select-Object -Last 1
$env:Path = "$($buildTools.FullName);$env:Path"   # apksigner

Step "코드 준비 ($Tag)"
$url = (git -C $Game remote get-url origin).Trim()
if (-not (Test-Path "$Build\.git")) { Run { git clone --quiet $url $Build } 'git clone' }
else { Run { git -C $Build remote set-url origin $url } 'remote' }
Run { git -C $Build fetch --quiet --tags --force origin } 'git fetch'
Run { git -C $Build checkout --quiet --force $Tag } 'git checkout'
Remove-Item -Recurse -Force "$Build\app\android", "$Build\app\dist" -ErrorAction SilentlyContinue
$version = (Get-Content "$Build\app\package.json" -Raw | ConvertFrom-Json).version
$code = [int](git -C $Build rev-list --count $Tag)   # 안드로이드 버전 번호: 커밋 수 (항상 증가)
Push-Location "$Build\app"
try {
  Run { npm ci --no-fund --no-audit } 'npm ci'

  Step '윈도우 앱 (설치·설치 없이·스토브 zip)'
  Run { npx electron-builder --win portable nsis zip --publish never } 'electron-builder'

  Step "안드로이드 앱 (버전 $version / 번호 $code)"
  Run { npx cap add android } 'cap add'
  Run { npx @capacitor/assets generate --android --iconBackgroundColor '#101322' --splashBackgroundColor '#101322' --splashBackgroundColorDark '#101322' } '아이콘 생성'
  $gradle = 'android\app\build.gradle'
  $g = Get-Content $gradle -Raw
  $g = $g -replace 'versionCode \d+', "versionCode $code" -replace 'versionName "[^"]*"', "versionName `"$version`""
  [IO.File]::WriteAllText((Resolve-Path $gradle), $g, [Text.UTF8Encoding]::new($false))
  Run { npx cap sync android } 'cap sync'
  Run { npx cap build android --androidreleasetype APK --signing-type apksigner --keystorepath "$Sign\yangsechan-release.jks" --keystorepass $pw --keystorealias yangsechan --keystorealiaspass $pw } '안드로이드 빌드'
  $apk = Get-ChildItem 'android\app\build\outputs\apk\release' -Filter '*-signed.apk' | Select-Object -First 1
  if (-not $apk) { throw '서명된 APK를 찾을 수 없습니다.' }

  Step "다운로드 폴더에 올리기 → $Out"
  $tmp = "$Out.tmp"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Copy-Item $apk.FullName "$tmp\yangsechan.apk"
  Copy-Item 'dist\*-setup.exe', 'dist\*-portable.exe', 'dist\*-stove.zip' $tmp
  Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
  Rename-Item $tmp (Split-Path $Out -Leaf)   # 다 만든 뒤 한 번에 공개 (반쯤 만든 파일이 보이지 않게)
  Get-ChildItem $Out | ForEach-Object { Write-Host ("  {0,-38} {1,6:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
} finally { Pop-Location }
Write-Host "`n완료: https://yangsechan.kr/download" -ForegroundColor Green

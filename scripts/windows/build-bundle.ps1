# build-bundle.ps1 — package the node as a win-x64 installer.
#
# Mirrors scripts/build-tarball.sh for Windows: builds the workspace, stages a
# self-contained app tree with a production node_modules (the win-x64
# better-sqlite3 prebuild is fetched HERE, on the Windows runner), bundles the
# official node.exe, adds the three .cmd launchers, and wraps it all with Inno
# Setup. Run on windows-latest after `pnpm install --frozen-lockfile`.
#
# Output: notis-node-<version>-win-x64-setup.exe in the repo root.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $RepoRoot

$Version = (& node -p "require('./package.json').version").Trim()
$NodeVer = "v$((& node -p 'process.versions.node').Trim())"   # bundle the runtime we build with
$Temp    = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$Stage   = Join-Path $Temp "notis-stage"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path "$Stage\app", "$Stage\node" | Out-Null

Write-Host "==> Building workspace"
& pnpm build

# --- 1. App tree (robocopy; 0-7 are success, >=8 is failure) -----------------
Write-Host "==> Staging app tree"
& robocopy $RepoRoot "$Stage\app" /E /NFL /NDL /NJH /NJS /NP `
  /XD .git .github .claude node_modules docs prompts tmp `
  /XF *.db *.db-wal *.db-shm *.deb *.tar.gz CLAUDE.md SETTINGS.md *.key *.pem *.der ".env" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
$global:LASTEXITCODE = 0

# --- 2. Production node_modules (win-x64 better-sqlite3 prebuild) -------------
Write-Host "==> Installing production dependencies"
Push-Location "$Stage\app"
& pnpm approve-builds better-sqlite3 cbor-extract esbuild 2>&1 | Out-Null
& pnpm install --prod --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "pnpm install --prod failed" }
Pop-Location
if (-not (Test-Path "$Stage\app\packages\node\dist\index.js")) { throw "node dist/ missing — build failed" }

# --- 3. Bundle the official Node win-x64 runtime -----------------------------
Write-Host "==> Downloading Node $NodeVer win-x64"
$Zip = Join-Path $Temp "node.zip"
Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip" -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath (Join-Path $Temp "nodert") -Force
Copy-Item (Join-Path $Temp "nodert\node-$NodeVer-win-x64\node.exe") "$Stage\node\node.exe"

# --- 4. Launchers ------------------------------------------------------------
Write-Host "==> Copying launchers"
Copy-Item "$PSScriptRoot\launch-node.cmd", "$PSScriptRoot\launch-miner.cmd", "$PSScriptRoot\open-ui.cmd" $Stage

# --- 5. Inno Setup installer -------------------------------------------------
Write-Host "==> Running Inno Setup"
$ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $ISCC)) { $ISCC = "${env:ProgramFiles}\Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $ISCC)) { & choco install innosetup -y; $ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
& $ISCC "/DMyAppVersion=$Version" "/DStageDir=$Stage" "/O$RepoRoot" "$PSScriptRoot\notis.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }

Write-Host "==> Done: notis-node-$Version-win-x64-setup.exe"

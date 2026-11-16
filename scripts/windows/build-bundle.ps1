# build-bundle.ps1 — package the node as a win-x64 installer.
#
# `pnpm build`, download the official node.exe into $Stage\node, then run
# `node scripts\bundle-node.mjs --out $Stage\app --node-exe $Stage\node\node.exe`
# so the bundler's start check runs under the runtime the installer carries.
# The launchers and Inno Setup follow.
#
# Requires (build host): node (>=24), pnpm, Inno Setup 6.
# Output: notis-node-<version>-win-x64-setup.exe in the repo root.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $RepoRoot

$Version = (& node -p "require('./package.json').version").Trim()
$NodeVer = "v$((& node -p 'process.versions.node').Trim())"
$Temp    = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$Stage   = Join-Path $Temp "notis-stage"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path "$Stage\node" | Out-Null

Write-Host "==> Building workspace"
& pnpm build

# --- 1. Bundle the official Node win-x64 runtime -----------------------------
Write-Host "==> Downloading Node $NodeVer win-x64"
$Zip = Join-Path $Temp "node.zip"
# The runtime is taken from nodejs.org as served, with no checksum
# (NODE_INTERFACE → The packaged node).
Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip" -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath (Join-Path $Temp "nodert") -Force
Copy-Item (Join-Path $Temp "nodert\node-$NodeVer-win-x64\node.exe") "$Stage\node\node.exe"

# --- 2. Bundle the node and miner-consolidate into $Stage\app ---------------
# (NODE_INTERFACE → "The packages carry the node as one bundle, beside the
# native modules it loads."). No faucet: the Windows installer ships no
# faucet unit. The bundler's start check runs under the carried node.exe.
Write-Host "==> Bundling into $Stage\app"
& node "$RepoRoot\scripts\bundle-node.mjs" --out "$Stage\app" --node-exe "$Stage\node\node.exe"
if ($LASTEXITCODE -ne 0) { throw "bundle-node.mjs failed ($LASTEXITCODE)" }

# --- 3. Launchers ------------------------------------------------------------
Write-Host "==> Copying launchers"
Copy-Item "$PSScriptRoot\launch-node.cmd", "$PSScriptRoot\launch-miner.cmd" $Stage

# --- 4. Inno Setup installer -------------------------------------------------
Write-Host "==> Running Inno Setup"
$ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $ISCC)) { $ISCC = "${env:ProgramFiles}\Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $ISCC)) { & choco install innosetup -y; $ISCC = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
& $ISCC "/DMyAppVersion=$Version" "/DStageDir=$Stage" "/O$RepoRoot" "$PSScriptRoot\notis.iss"
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }

Write-Host "==> Done: notis-node-$Version-win-x64-setup.exe"

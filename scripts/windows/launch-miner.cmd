@echo off
rem Notis testnet node + miner loop. Close this window to stop mining.
cd /d "%~dp0"
set "NETWORK_TYPE=testnet"
set "PORT=3000"
set "FAUCET_URL=https://notis.fun/testnet/faucet"
if not exist "%APPDATA%\Notis" mkdir "%APPDATA%\Notis"
set "DB_PATH=%APPDATA%\Notis\notis.db"

rem Persistent coinbase key (MINER_PUBKEY) — gen-miner-key.mjs prints the pubkey.
rem Read via a temp file rather than for/f to avoid quoting the nested command.
"%~dp0node\node.exe" "%~dp0app\packages\node\scripts\gen-miner-key.mjs" "%APPDATA%\Notis\miner-key.json" > "%TEMP%\notis_pub.txt"
set /p MINER_PUBKEY=<"%TEMP%\notis_pub.txt"
"%~dp0node\node.exe" -e "console.log(require('crypto').randomUUID())" > "%TEMP%\notis_sec.txt"
set /p MINING_SECRET=<"%TEMP%\notis_sec.txt"
del "%TEMP%\notis_pub.txt" "%TEMP%\notis_sec.txt" 2>nul

set "NODE_ROLE=miner"
if "%MINER_PCT%"=="" set "MINER_PCT=25"

rem The miner-role node in its own window; this window runs the miner loop.
start "Notis Node (miner)" "%~dp0node\node.exe" "%~dp0app\packages\node\dist\index.js"
timeout /t 3 >nul
set "NODE_URL=http://localhost:3000"
"%~dp0node\node.exe" "%~dp0app\packages\node\scripts\miner.mjs"

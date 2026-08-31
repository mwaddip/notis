@echo off
rem Notis testnet node (server). No system Node needed — uses the bundled node.exe.
cd /d "%~dp0"
set "NETWORK_TYPE=testnet"
set "PORT=3000"
set "FAUCET_URL=https://notis.fun/testnet/faucet"
if not exist "%APPDATA%\Notis" mkdir "%APPDATA%\Notis"
set "DB_PATH=%APPDATA%\Notis\notis.db"
"%~dp0node\node.exe" "%~dp0app\packages\node\dist\index.js"

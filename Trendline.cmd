@echo off
rem Trendline launcher. Clears the Electron-as-Node flag some parent shells set.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"

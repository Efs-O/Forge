@echo off
rem Install the newest built VSIX into this VS Code build. Usage: install-vsix.cmd [path.vsix]
rem A hardcoded version here once installed the previous release after a fresh build,
rem so the newest forge-llm-*.vsix in the repo root is now picked by modification time.
rem The repo root is this script's own folder's parent; no machine path is hardcoded.
rem The VS Code CLI comes from FORGE_CODE_CMD, else `code` on PATH.
setlocal
for %%r in ("%~dp0..\..") do set "REPO=%%~fr"
set "VSIX=%~1"
for /f "delims=" %%f in ('dir /b /o-d "%REPO%\forge-llm-*.vsix"') do (
  if not defined VSIX set "VSIX=%%f"
)
if not defined VSIX (
  echo No forge-llm-*.vsix in %REPO% - run npm run package first.
  exit /b 1
)
set "CODE_CMD=%FORGE_CODE_CMD%"
if not defined CODE_CMD for /f "delims=" %%c in ('where code 2^>nul') do if not defined CODE_CMD set "CODE_CMD=%%c"
if not defined CODE_CMD (
  echo Set FORGE_CODE_CMD to the path of VS Code's bin\code.cmd.
  exit /b 1
)
echo installing %VSIX%
call "%CODE_CMD%" --install-extension "%REPO%\%VSIX%" --force

@echo off
rem Install the newest built VSIX into this VS Code build. Usage: install-vsix.cmd [path.vsix]
rem A hardcoded version here once installed the previous release after a fresh build,
rem so the newest forge-llm-*.vsix in the repo root is now picked by modification time.
rem The folder is quoted here so the space in the CLI path never reaches bash.
setlocal
set "VSIX=%~1"
for /f "delims=" %%f in ('dir /b /o-d "N:\vs code apps\Forge\forge-llm-*.vsix"') do (
  if not defined VSIX set "VSIX=%%f"
)
echo installing %VSIX%
call "N:\VScode\Microsoft VS Code\bin\code.cmd" --install-extension "N:\vs code apps\Forge\%VSIX%" --force

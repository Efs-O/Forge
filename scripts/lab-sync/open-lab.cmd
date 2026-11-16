@echo off
rem Open the tool-test lab in its own VS Code window. Usage: open-lab.cmd <lab folder>
rem The folder is argument 1, else FORGE_LAB_DIR. The VS Code CLI comes from
rem FORGE_CODE_CMD, else `code` on PATH. No machine path is hardcoded.
setlocal
set "LAB=%~1"
if not defined LAB set "LAB=%FORGE_LAB_DIR%"
if not defined LAB (
  echo Usage: open-lab.cmd ^<lab folder^> ^(or set FORGE_LAB_DIR^)
  exit /b 1
)
set "CODE_CMD=%FORGE_CODE_CMD%"
if not defined CODE_CMD for /f "delims=" %%c in ('where code 2^>nul') do if not defined CODE_CMD set "CODE_CMD=%%c"
if not defined CODE_CMD (
  echo Set FORGE_CODE_CMD to the path of VS Code's bin\code.cmd.
  exit /b 1
)
call "%CODE_CMD%" -n "%LAB%"

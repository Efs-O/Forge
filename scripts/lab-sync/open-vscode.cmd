@echo off
rem Open (or focus) a VS Code window on a folder, from any shell.
rem Usage: open-vscode.cmd "N:\path\to\folder"        -> new window
rem        open-vscode.cmd --list-extensions          -> any other VS Code CLI flag
rem The real CLI is the versioned build's bin\code.cmd; calling Code.exe directly
rem makes Electron try to RUN the folder as a Node app, and code.cmd cannot be
rem called from bash because its own path contains spaces.
call "N:\VScode\Microsoft VS Code\bin\code.cmd" -n %*

# Redline

Cursor-style review for any AI agent (Claude Code, Codex, Aider, ...) in VS Code.
When something outside VS Code writes to a file, the changed lines get highlighted
with **Keep / Undo** buttons per change, plus **Keep all / Undo all** at the top of the file.
Removed lines show as a red line; hover to see the old code. The status bar shows how many
files are pending (click it to jump to one). The editor title bar has Keep all / Undo all
and a Next file button to step through every pending file.

## Install

    npm install && npm run package
    code --install-extension redline-0.0.1.vsix

Share the `.vsix` with anyone, who install it the same way (or use "Extensions: Install from VSIX...").
To develop: open this folder in VS Code and press F5.

## How it works

Your saves from VS Code are trusted. Any other write to disk counts as the agent's and is diffed against
the last trusted version of the file (or the git-staged version if VS Code never saw the file). Keep
moves a change into that trusted version. Undo reverts it and saves the file, so the agent sees the revert too.

## Known limits (MVP)

- Every external write counts as the agent's: `git checkout`, formatters run in a terminal, and so on. Gitignored files are skipped. "Keep All Changes in All Files" clears everything.
- Pending state lives in memory and is lost when VS Code reloads.

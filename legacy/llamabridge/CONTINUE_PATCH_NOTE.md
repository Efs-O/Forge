## Continue Local Patch

This repo can improve local model behavior through the bridge, but the installed Continue extension may still expose an edit tool that is too loose for some local models such as Gemma 4.

### What was patched locally

Installed Continue bundle:

- `C:\Users\efso office\.cursor\extensions\continue.continue-1.2.22-win32-x64\out\extension.js`

Backup created before patch:

- `C:\Users\efso office\.cursor\extensions\continue.continue-1.2.22-win32-x64\out\extension.js.bak-2026-04-25`

Behavior change:

- Removed `edit_existing_file` from the tool list offered to non-recommended agent models.
- Continue will still offer `single_find_and_replace` for those models.
- Recommended agent models still receive `multi_edit`.

### Why this patch exists

`edit_existing_file` uses a weak schema:

- `filepath: string`
- `changes: string`

That free-form `changes` field is easy for smaller local models to misuse, which can lead to malformed tool calls, loops, or freezes during edit attempts.

### If you need to revert

Close Cursor, then restore the backup over the patched file:

```powershell
Copy-Item `
  -LiteralPath "C:\Users\efso office\.cursor\extensions\continue.continue-1.2.22-win32-x64\out\extension.js.bak-2026-04-25" `
  -Destination "C:\Users\efso office\.cursor\extensions\continue.continue-1.2.22-win32-x64\out\extension.js" `
  -Force
```

Then reopen Cursor.

### Important

This is a local patch to the installed Continue extension, not a bridge feature. Users who want the same behavior need to patch their local Continue bundle or build Continue from source with the same change.

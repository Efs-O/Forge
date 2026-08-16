# Forge Tool Coverage Matrix

Generated: 2026-07-17T19:54:28.699Z (hand-amended 2026-08-16 to add `append_file`
— regenerating discards the merged model-evidence columns, so re-run with
`--model-evidence` if you need a full refresh)

The inventory and permissions come from the constructors registered by `registerAllTools.ts`; worker visibility comes from `WorkerAccessPolicy.ts`. “Harness” means schema emission is available but not executed by default.

| Tool | Origin | Permission | Coordinator | Read worker | Write worker | Model schema test | Handler test | Live test | Side effect |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| append_file | native | write | yes | no | no | harness | automated | not run | write |
| apply_line_edits | native | write | yes | no | yes | passed | automated | schema passed | write |
| ask_local_agent | native | delegate | yes | no | no | passed | automated | schema passed | delegate |
| ask_user | native | read | yes | no | no | passed | automated | schema passed | read-only |
| commit | native | git-write | yes | no | no | passed | automated | schema passed | git-write |
| copy_to_clipboard | native | read | yes | no | no | passed | automated | schema passed | read-only |
| create_branch | native | git-write | yes | no | no | passed | automated | schema passed | git-write |
| create_directory | native | write | yes | no | no | passed | automated | schema passed | write |
| delete_file | native | delete | yes | no | no | passed | automated | schema passed | delete |
| dispatch_workers | native | delegate | yes | no | no | passed | automated | schema passed | delegate |
| exec_command | native | headless | yes | no | no | passed | automated | schema passed | headless |
| find_files | native | read | yes | yes | yes | passed | automated | schema passed | read-only |
| find_references | native | read | yes | no | no | passed | automated | schema passed | read-only |
| format_file | native | write | yes | no | no | passed | automated | schema passed | write |
| get_diagnostics | native | read | yes | yes | yes | passed | automated | schema passed | read-only |
| get_digest | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| get_document_symbols | native | read | yes | yes | yes | passed | automated | schema passed | read-only |
| get_hover | native | read | yes | no | no | passed | automated | schema passed | read-only |
| get_profile | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| get_workspace_symbols | native | read | yes | no | no | passed | automated | schema passed | read-only |
| git_blame | native | git-read | yes | no | no | passed | automated | schema passed | read-only |
| git_diff | native | git-read | yes | no | no | passed | automated | schema passed | read-only |
| git_log | native | git-read | yes | no | no | passed | automated | schema passed | read-only |
| git_show | native | git-read | yes | no | no | passed | automated | schema passed | read-only |
| git_status | native | git-read | yes | no | no | passed | automated | schema passed | read-only |
| go_to_definition | native | read | yes | no | no | passed | automated | schema passed | read-only |
| insert_code | native | write | yes | no | no | passed | automated | schema passed | write |
| list_directory | native | read | yes | yes | yes | passed | automated | handler passed | read-only |
| list_memories | native | read | yes | no | no | passed | automated | schema passed | read-only |
| list_worker_models | native | delegate | yes | no | no | passed | automated | schema passed | delegate |
| move_file | native | write | yes | no | no | passed | automated | schema passed | write |
| open_url_in_browser | native | read | yes | no | no | passed | automated | schema passed | read-only |
| read_clipboard | native | read | yes | no | no | passed | automated | schema passed | read-only |
| read_file | native | read | yes | yes | yes | passed | automated | handler passed | read-only |
| read_raw_session | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| read_session | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| recall | native | read | yes | no | no | passed | automated | schema passed | read-only |
| remember | native | read | yes | no | no | passed | automated | schema passed | read-only |
| rename_symbol | native | write | yes | no | no | passed | automated | schema passed | write |
| edit_file | native | write | yes | no | yes | passed | automated | handler passed | write |
| replace_selection | native | write | yes | no | no | passed | automated | schema passed | write |
| run_build | native | headless | yes | no | no | passed | automated | schema passed | headless |
| run_terminal | native | terminal | yes | no | no | passed | automated | schema passed | terminal |
| run_tests | native | headless | yes | no | no | passed | automated | handler passed | headless |
| search_code | native | read | yes | yes | yes | passed | automated | handler passed | read-only |
| search_codebase | native | read | yes | no | no | passed | automated | schema passed | read-only |
| search_raw_transcripts | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| search_sessions | mcp | read | yes | no | no | passed | automated | schema passed | external process |
| show_diff | native | read | yes | no | no | passed | automated | schema passed | read-only |
| show_notification | native | read | yes | no | no | passed | automated | schema passed | read-only |
| stage | native | git-write | yes | no | no | passed | automated | schema passed | git-write |
| switch_branch | native | git-write | yes | no | no | passed | automated | schema passed | git-write |
| web_fetch | native | fetch | yes | no | no | passed | automated | schema passed | fetch |
| web_search | native | search | yes | no | no | passed | automated | schema passed | search |
| write_file | native | write | yes | no | yes | passed | automated | handler passed | write |

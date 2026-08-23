# Forge Tool Coverage Matrix

Generated: 2026-08-23T15:38:45.063Z

The inventory and permissions come from the constructors registered by `registerAllTools.ts`. “Harness” means schema emission is available but not executed by default.

| Tool | Origin | Permission | Coordinator | Model schema test | Handler test | Live test | Side effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| append_file | native | write | yes | harness | automated | opt-in | write |
| apply_line_edits | native | write | yes | passed | automated | schema passed | write |
| ask_local_agent | native | delegate | yes | passed | automated | schema passed | delegate |
| ask_user | native | read | yes | passed | automated | schema passed | read-only |
| commit | native | git-write | yes | passed | automated | schema passed | git-write |
| copy_to_clipboard | native | read | yes | passed | automated | schema passed | read-only |
| create_branch | native | git-write | yes | passed | automated | schema passed | git-write |
| create_directory | native | write | yes | passed | automated | schema passed | write |
| delete_file | native | delete | yes | passed | automated | schema passed | delete |
| edit_file | native | write | yes | harness | automated | opt-in | write |
| exec_command | native | headless | yes | passed | automated | schema passed | headless |
| find_files | native | read | yes | passed | automated | schema passed | read-only |
| find_references | native | read | yes | passed | automated | schema passed | read-only |
| format_file | native | write | yes | passed | automated | schema passed | write |
| get_diagnostics | native | read | yes | passed | automated | schema passed | read-only |
| get_document_symbols | native | read | yes | passed | automated | schema passed | read-only |
| get_hover | native | read | yes | passed | automated | schema passed | read-only |
| get_workspace_symbols | native | read | yes | passed | automated | schema passed | read-only |
| git_blame | native | git-read | yes | passed | automated | schema passed | read-only |
| git_diff | native | git-read | yes | passed | automated | schema passed | read-only |
| git_log | native | git-read | yes | passed | automated | schema passed | read-only |
| git_show | native | git-read | yes | passed | automated | schema passed | read-only |
| git_status | native | git-read | yes | passed | automated | schema passed | read-only |
| go_to_definition | native | read | yes | passed | automated | schema passed | read-only |
| insert_code | native | write | yes | passed | automated | schema passed | write |
| list_directory | native | read | yes | passed | automated | handler passed | read-only |
| list_memories | native | read | yes | passed | automated | schema passed | read-only |
| move_file | native | write | yes | passed | automated | schema passed | write |
| open_url_in_browser | native | read | yes | passed | automated | schema passed | read-only |
| query_powershell | native | headless | yes | harness | automated | opt-in | headless |
| read_clipboard | native | read | yes | passed | automated | schema passed | read-only |
| read_file | native | read | yes | passed | automated | handler passed | read-only |
| recall | native | read | yes | passed | automated | schema passed | read-only |
| remember | native | read | yes | passed | automated | schema passed | read-only |
| rename_symbol | native | write | yes | passed | automated | schema passed | write |
| replace_selection | native | write | yes | passed | automated | schema passed | write |
| run_build | native | headless | yes | passed | automated | schema passed | headless |
| run_terminal | native | terminal | yes | passed | automated | schema passed | terminal |
| run_tests | native | headless | yes | passed | automated | handler passed | headless |
| search_code | native | read | yes | passed | automated | handler passed | read-only |
| search_codebase | native | read | yes | passed | automated | schema passed | read-only |
| show_diff | native | read | yes | passed | automated | schema passed | read-only |
| show_notification | native | read | yes | passed | automated | schema passed | read-only |
| stage | native | git-write | yes | passed | automated | schema passed | git-write |
| switch_branch | native | git-write | yes | passed | automated | schema passed | git-write |
| web_fetch | native | fetch | yes | passed | automated | schema passed | fetch |
| web_search | native | search | yes | passed | automated | schema passed | search |
| write_file | native | write | yes | passed | automated | handler passed | write |

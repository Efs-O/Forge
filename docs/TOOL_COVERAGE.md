# Forge Tool Coverage Matrix

Generated: 2026-08-26T11:12:54.268Z

The inventory and permissions come from the constructors registered by `registerAllTools.ts`. “Harness” means schema emission is available but not executed by default.

| Tool | Origin | Permission | Coordinator | Model schema test | Handler test | Live test | Side effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| append_file | native | write | yes | harness | automated | opt-in | write |
| apply_code_action | native | write | yes | harness | automated | opt-in | write |
| apply_line_edits | native | write | yes | harness | automated | opt-in | write |
| ask_local_agent | native | delegate | yes | harness | automated | opt-in | delegate |
| ask_user | native | read | yes | harness | automated | opt-in | read-only |
| commit | native | git-write | yes | harness | automated | opt-in | git-write |
| copy_to_clipboard | native | read | yes | harness | automated | opt-in | read-only |
| create_branch | native | git-write | yes | harness | automated | opt-in | git-write |
| create_directory | native | write | yes | harness | automated | opt-in | write |
| delete_file | native | delete | yes | harness | automated | opt-in | delete |
| edit_file | native | write | yes | harness | automated | opt-in | write |
| edit_notebook_cell | native | write | yes | harness | automated | opt-in | write |
| exec_command | native | headless | yes | harness | automated | opt-in | headless |
| find_files | native | read | yes | harness | automated | opt-in | read-only |
| find_references | native | read | yes | harness | automated | opt-in | read-only |
| format_file | native | write | yes | harness | automated | opt-in | write |
| get_code_actions | native | read | yes | harness | automated | opt-in | read-only |
| get_diagnostics | native | read | yes | harness | automated | opt-in | read-only |
| get_document_symbols | native | read | yes | harness | automated | opt-in | read-only |
| get_hover | native | read | yes | harness | automated | opt-in | read-only |
| get_workspace_symbols | native | read | yes | harness | automated | opt-in | read-only |
| git_blame | native | git-read | yes | harness | automated | opt-in | read-only |
| git_diff | native | git-read | yes | harness | automated | opt-in | read-only |
| git_log | native | git-read | yes | harness | automated | opt-in | read-only |
| git_show | native | git-read | yes | harness | automated | opt-in | read-only |
| git_status | native | git-read | yes | harness | automated | opt-in | read-only |
| go_to_definition | native | read | yes | harness | automated | opt-in | read-only |
| insert_code | native | write | yes | harness | automated | opt-in | write |
| list_directory | native | read | yes | harness | automated | opt-in | read-only |
| list_executions | native | headless | yes | harness | automated | opt-in | headless |
| list_memories | native | read | yes | harness | automated | opt-in | read-only |
| list_workspace_tasks | native | read | yes | harness | automated | opt-in | read-only |
| monitor_execution | native | headless | yes | harness | automated | opt-in | headless |
| move_file | native | write | yes | harness | automated | opt-in | write |
| open_url_in_browser | native | read | yes | harness | automated | opt-in | read-only |
| query_powershell | native | headless | yes | harness | automated | opt-in | headless |
| read_clipboard | native | read | yes | harness | automated | opt-in | read-only |
| read_file | native | read | yes | harness | automated | opt-in | read-only |
| read_notebook | native | read | yes | harness | automated | opt-in | read-only |
| recall | native | read | yes | harness | automated | opt-in | read-only |
| remember | native | read | yes | harness | automated | opt-in | read-only |
| rename_symbol | native | write | yes | harness | automated | opt-in | write |
| replace_selection | native | write | yes | harness | automated | opt-in | write |
| run_build | native | headless | yes | harness | automated | opt-in | headless |
| run_terminal | native | terminal | yes | harness | automated | opt-in | terminal |
| run_tests | native | headless | yes | harness | automated | opt-in | headless |
| run_workspace_task | native | headless | yes | harness | automated | opt-in | headless |
| search_code | native | read | yes | harness | automated | opt-in | read-only |
| search_codebase | native | read | yes | harness | automated | opt-in | read-only |
| show_diff | native | read | yes | harness | automated | opt-in | read-only |
| show_notification | native | read | yes | harness | automated | opt-in | read-only |
| stage | native | git-write | yes | harness | automated | opt-in | git-write |
| stop_execution | native | headless | yes | harness | automated | opt-in | headless |
| switch_branch | native | git-write | yes | harness | automated | opt-in | git-write |
| view_image | native | read | yes | harness | automated | opt-in | read-only |
| view_video | native | read | yes | harness | automated | opt-in | read-only |
| web_fetch | native | fetch | yes | harness | automated | opt-in | fetch |
| web_search | native | search | yes | harness | automated | opt-in | search |
| write_file | native | write | yes | harness | automated | opt-in | write |

# VS Code commands

Every command Forge contributes to the palette. This lived in `README.md`,
which is also the Marketplace and Open VSX Overview page: a forty-row table of
command ids is reference a user looks up once and a store visitor scrolls past
forever. It was 10.6% of that page.

These commands are currently contributed by the extension.

### Core sidebar and backend

| Command                       | Description                          |
| ----------------------------- | ------------------------------------ |
| `Forge: Open Sidebar`         | Open the Forge sidebar               |
| `Forge: Start Backend`        | Start the active backend             |
| `Forge: Stop Backend`         | Stop the active backend              |
| `Forge: Show Backend Console` | Reveal backend logs or console       |
| `Forge: Restart Backend`      | Restart the managed backend          |
| `Forge: Open Config`          | Open the active config file          |
| `Forge: Validate Config`      | Validate the active config           |
| `Forge: Pick Model`           | Pick the active model                |
| `Forge: Pick GGUF Model File` | Pick a GGUF file during setup        |
| `Forge: Setup Wizard`         | Run the first-run or repair flow     |
| `Forge: Unload Model`         | Stop all backends and release models |
| `Forge: New Chat`             | Open a new conversation tab          |
| `Forge: Clear Active Chat`    | Clear the active tab                 |
| `Forge: Undo Last Turn`       | Restore the previous checkpoint      |
| `Forge: Keep Changes`         | Accept the current checkpoint        |

### Control-server commands

| Command                                | Description                                  |
| -------------------------------------- | -------------------------------------------- |
| `Forge: Ensure Model (load on demand)` | Ask the control server to load a model       |
| `Forge: Release Model`                 | Ask the control server to release a model    |
| `Forge: Control Server Status`         | Show control-server status and active models |

### Tokens, search, and setup helpers

| Command                           | Description                         |
| --------------------------------- | ----------------------------------- |
| `Forge: Set Search API Key`       | Store a Tavily or Brave API key     |
| `Forge: Set Cloud Provider Token` | Store a cloud-provider bearer token |

### Editor and review helpers

| Command                                   | Description                                  |
| ----------------------------------------- | -------------------------------------------- |
| `Forge: Explain Selection`                | Explain the active selection                 |
| `Forge: Review Selection`                 | Review the active selection                  |
| `Forge: Generate Tests For Selection`     | Draft tests for the selection                |
| `Forge: Refactor Selection`               | Refactor the selection                       |
| `Forge: Run Explain Selection`            | Execute the explain flow immediately         |
| `Forge: Run Review Selection`             | Execute the review flow immediately          |
| `Forge: Run Generate Tests For Selection` | Execute the test-generation flow immediately |
| `Forge: Run Refactor Selection`           | Execute the refactor flow immediately        |
| `Forge: Explain Diagnostic`               | Explain an editor diagnostic                 |
| `Forge: Propose Fix For Diagnostic`       | Draft a fix for a diagnostic                 |
| `Forge: Run Fix For Diagnostic`           | Execute a fix flow for a diagnostic          |
| `Forge: Propose Fix For File Diagnostics` | Review diagnostics across the active file    |
| `Forge: Use Current File As Context`      | Prefill context with the current file        |
| `Forge: Use Selection As Context`         | Prefill context with the selection           |
| `Forge: Use Open Tabs As Context`         | Prefill context from open tabs               |
| `Forge: Pick Files For Context`           | Pick context files manually                  |
| `Forge: Draft Plan In Scratch Document`   | Generate a planning scratch doc              |
| `Forge: Draft Review In Scratch Document` | Generate a review scratch doc                |


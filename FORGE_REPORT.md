# Forge: Detailed Project Report

## 1. Introduction
Forge is a local-first AI coding assistant integrated into VS Code. It is designed for developers who prioritize privacy, security, and control over their AI-assisted development workflows. Unlike cloud-based assistants, Forge runs models locally, ensuring that no code or sensitive data ever leaves the user's machine.

## 2. Architecture and Core Components

### 2.1 Backend Engine
Forge does not implement the LLM inference itself but acts as a sophisticated orchestrator for local inference engines:
- **llama.cpp (`llama-server`)**: Forge can manage its own `llama-server` instance. This allows for direct control over GGUF models, GPU layer offloading, and context window management.
- **Ollama**: Forge supports Ollama as a provider, allowing users to leverage Ollama's model management and easy setup.
- **Bridge Mode**: For advanced users, Forge can act as a client for any existing OpenAI-compatible server (local or remote).

### 2.2 Frontend & UI
- **VS Code Extension**: The extension leverages the VS Code Webview API to provide a rich, interactive chat interface.
- **Multi-tab Interface**: Users can maintain multiple independent conversation contexts simultaneously.
- **Integrated Terminal & File Explorer**: The AI has direct access to the workspace via specialized tools, enabling it to perform complex coding tasks.

## 3. Key Features & Capabilities

### 3.1 Advanced Tool Use
Forge implements a strict, typed tool-calling system using JSON Schema. This ensures reliable interaction between the LLM and the local environment. Supported tools include:
- **File Operations**: Reading, writing, and replacing content in files.
- **Terminal Execution**: Running commands with user-in-the-loop confirmation.
- **Web Search**: Integration with Tavily or Brave for real-time information retrieval.
- **LSP Integration**: Uses Language Server Protocol (LSP) for intelligent code navigation (Go to Definition, Find References, etc.).
- **Git Integration**: Full support for Git operations (status, log, diff, blame, branch management, etc.).
- **Memory System**: A persistent "remember/recall" mechanism to store and retrieve workspace-specific context.

### 3.2 Workflow Management
- **Checkpoint System (Undo/Keep)**: One of Forge's most distinctive features. After any turn that modifies files, Forge creates a checkpoint. Users can instantly revert all changes from that turn or "keep" them to commit the state.
- **Reasoning/Thinking Display**: Optimized for modern reasoning models (like DeepSeek-R1). It can display the model's "thought process" in a collapsible UI element or strip it for a cleaner chat experience.
- **Slash Commands**: A productivity-focused command system (e.g., `/newChat`, `/undo`, `/compact`, `/review`) for rapid interaction.

### 3.3 Model Flexibility
- **Hot Model Swapping**: Users can switch between different GGUF or Ollama models without restarting VS Code.
- **Metadata Inspection**: Forge inspects the `llama.cpp` runtime metadata to detect support for specific features like tool calling or thinking modes, providing warnings if a model is incompatible.

## 4. Privacy and Security Model

### 4.1 Data Sovereignty
- **Zero Telemetry**: No usage data, logs, or analytics are sent to any external servers.
- **Local-First**: All inference happens on the local machine.
- **No Cloud Dependencies**: The core functionality does not require an internet connection (except for optional web search).

### 4.2 Execution Safety (Defense in Depth)
Forge employs multiple layers of security to prevent accidental or malicious system damage:
1.  **Command Denylisting**: A robust, platform-aware denylist (e.g., blocking `rm -rf`, `git reset --hard`, `SQL DROP`, etc.) prevents high-risk commands from being executed.
2.  **Shell Operator Restriction**: To prevent command injection and unexpected behavior, shell operators (like `&&`, `|`, `;`) are strictly banned in `exec_command` arguments.
3.  **PowerShell Guardrails**: Specifically targets dangerous PowerShell flags (like `-EncodedCommand`) to prevent obfuscated script execution.
4.  **Per-Action Confirmation Gate**: Every tool call (file write, terminal command) is gated by a user confirmation dialog. The AI cannot act on the system without explicit permission.
5.  **Direct Binary Execution**: Encourages the use of `exec_command` for direct binary execution rather than shell-based execution, reducing the attack surface.

## 5. Configuration and Setup

### 5.1 Workspace Configuration
Forge uses a `.forge/config.yaml` file within the project workspace to manage:
- Active model selection.
- `llama-server` parameters (host, port, GPU layers, context size).
- Model-specific settings (GGUF paths, thinking mode, stripping settings).
- Search provider API keys.

## 6. Conclusion
Forge bridges the gap between the convenience of cloud-based AI assistants and the necessity of local privacy and control. By providing a robust toolset, advanced workflow management, and seamless integration with local inference engines, it offers a professional-grade development experience for privacy-conscious engineers.

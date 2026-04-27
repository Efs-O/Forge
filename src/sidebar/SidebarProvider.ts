import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { BackendController } from '../backend/BackendController';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview, WebviewToHost } from './messageBridge';
import { streamChatCompletion } from '../llm/OpenAIClient';
import type { ChatCompletionRequest, ChatMessage, Mode, ToolCall } from '../llm/types';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import type { TemplateEngine } from '../llm/TemplateEngine';
import { mergeSampling } from '../llm/SamplingMerge';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry, MODE_PERMISSIONS } from '../tools/ToolRegistry';
import type { KeepUndoCodeLensProvider } from './KeepUndoCodeLens';
import { confirmToolCall } from '../tools/ConfirmationGate';
import { ToolFailureTracker, stripTools } from '../tools/StripTools';
import { getLogger } from '../util/logger';

const log = getLogger();
const MAX_TOOL_ROUNDS = 20;
const HISTORY_KEY = 'forge.conversation.history';
const WRITE_PERMISSIONS = new Set(['write', 'delete']);

// Rough token estimate: 4 chars per token
function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const len = typeof m.content === 'string' ? m.content.length : 0;
    return sum + Math.ceil(len / 4);
  }, 0);
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view?: vscode.WebviewView;
  private cancelController: AbortController | null = null;
  private history: ChatMessage[] = [];
  private failureTracker = new ToolFailureTracker();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: BackendController,
    private readonly config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceState: vscode.Memento,
    private readonly codeLens: KeepUndoCodeLensProvider,
    private readonly templateEngine?: TemplateEngine,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      this.handleMessage(raw as WebviewToHost);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  undo(): string[] {
    const restored = this.checkpoints.undo();
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed' });
    return restored;
  }

  keep(): void {
    this.checkpoints.keep();
    this.codeLens.clearPending();
    this.post({ type: 'checkpointDismissed' });
  }

  canUndo(): boolean { return this.checkpoints.canUndo(); }

  newChat(): void {
    this.history = [];
    this.failureTracker.reset();
    this.persistHistory();
    this.post({ type: 'newChat' });
    log.debug('[SidebarProvider] conversation reset');
  }

  /** Push active-editor selection text into webview input (v0.2) */
  sendSelectionContent(text: string): void {
    this.post({ type: 'selectionContent', text });
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  private post(msg: HostToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private handleMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'webviewReady':
        this.post({
          type: 'models',
          names: this.config.models.map((m) => m.name),
          active: this.config.active_model,
        });
        if (this.backend.isReady()) {
          this.post({ type: 'ready' });
        } else {
          this.post({ type: 'backendDown', message: 'Backend is starting…' });
        }
        // v0.9: restore persisted conversation
        this.restoreHistory();
        break;

      case 'send':
        void this.handleSend(msg.text, msg.mode);
        break;

      case 'cancel':
        this.cancelController?.abort();
        break;

      case 'switchModel':
        void (async () => {
          try {
            await this.backend.hotSwap(msg.name);
            this.history = [];
            this.persistHistory();
            this.post({ type: 'ready' });
          } catch (err) {
            this.post({ type: 'error', message: (err as Error).message });
          }
        })();
        break;

      case 'undo':
        try {
          const restored = this.undo();
          this.post({ type: 'token', text: `\n\n> ↩ Undid last turn — restored ${restored.length} file(s).\n\n` });
        } catch (err) { this.post({ type: 'error', message: (err as Error).message }); }
        break;

      case 'keep':
        try { this.keep(); }
        catch (err) { this.post({ type: 'error', message: (err as Error).message }); }
        break;

      case 'newChat':
        this.newChat();
        break;

      // v0.2: capture active editor selection
      case 'sendSelection': {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          this.sendSelectionContent(editor.document.getText(editor.selection));
        }
        break;
      }

      // v0.2: insert assistant message text at cursor
      case 'insertAtCursor':
        void (async () => {
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          await editor.edit((b) => b.insert(editor.selection.active, msg.text));
        })();
        break;

      // v0.2: replace selection with assistant message text
      case 'replaceSelection':
        void (async () => {
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          await editor.edit((b) => b.replace(editor.selection, msg.text));
        })();
        break;

      // v0.9: confirmResponse handled by pending promise (not here)
      case 'confirmResponse':
        break;

      // setInput is host→webview only; ignore if received from webview
      case 'setInput':
        break;
    }
  }

  // ── Agent turn ────────────────────────────────────────────────────────────

  private async handleSend(text: string, mode: Mode): Promise<void> {
    if (!this.backend.isReady()) {
      this.post({ type: 'error', message: 'Backend not ready. Check llama-server config.' });
      return;
    }

    this.cancelController = new AbortController();
    const turnId = `turn-${Date.now()}`;
    this.checkpoints.beginTurn(turnId);
    this.history.push({ role: 'user', content: text });

    // Active file context for template engine
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;

    log.debug(`[SidebarProvider] send mode=${mode} model=${this.config.active_model}`);

    try {
      await this.runAgentLoop(mode, activeFile);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn();
      if (this.checkpoints.depth() > depthBefore) {
        this.post({ type: 'checkpointReady' });
      }
      this.persistHistory();
      this.postTokenBudget();
    }
  }

  private async runAgentLoop(mode: Mode, activeFile?: string): Promise<void> {
    const allowed = MODE_PERMISSIONS[mode];
    const useStrip = this.failureTracker.shouldStrip();
    if (useStrip) {
      void vscode.window.showWarningMessage('Forge: tool calls disabled after repeated failures. Restart chat to re-enable.');
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (this.cancelController?.signal.aborted) {
        this.post({ type: 'done', finishReason: 'cancelled' });
        return;
      }

      const tmplCtx: Record<string, string> = {};
      if (activeFile) tmplCtx['activeFile'] = activeFile;
      if (this.config.custom_instructions) tmplCtx['customInstructions'] = this.config.custom_instructions;
      const messages = injectSystemPrompt(
        [...this.history],
        mode,
        this.templateEngine,
        tmplCtx,
      );

      let toolDefs = this.toolRegistry.definitions(allowed);
      let base: ChatCompletionRequest = {
        model: this.config.active_model,
        messages,
        stream: true,
        ...(toolDefs.length > 0 && !useStrip ? { tools: toolDefs } : {}),
      };
      const request = useStrip ? stripTools(mergeSampling(base, mode)) : mergeSampling(base, mode);

      let assistantContent = '';
      const { finishReason, toolCalls } = await this.streamOnce(request, (token) => {
        assistantContent += token;
        this.post({ type: 'token', text: token });
      });

      if (finishReason === 'tool_calls' && toolCalls?.length) {
        this.failureTracker.reset();
        this.history.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        await this.dispatchToolCalls(toolCalls, allowed);
        continue;
      }

      if (assistantContent) {
        this.history.push({ role: 'assistant', content: assistantContent });
      }
      this.post({ type: 'done', finishReason });
      return;
    }

    this.post({ type: 'error', message: 'Forge: agent exceeded maximum tool rounds.' });
  }

  private async dispatchToolCalls(
    toolCalls: ToolCall[],
    allowed: Set<import('../tools/ToolRegistry').ToolPermission>,
  ): Promise<void> {
    for (const tc of toolCalls) {
      let result: string;
      try {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          this.failureTracker.record();
          result = `Error: malformed tool arguments (invalid JSON)`;
          this.postToolResult(tc, result);
          continue;
        }

        const reg = this.toolRegistry.get(tc.function.name);
        if (!reg) {
          result = `Error: unknown tool "${tc.function.name}"`;
          this.postToolResult(tc, result);
          continue;
        }

        // Confirmation gate for write/delete/terminal/git-write tools
        const needsConfirm = WRITE_PERMISSIONS.has(reg.permission) || reg.permission === 'terminal' || reg.permission === 'git';
        if (needsConfirm) {
          const detail = JSON.stringify(args, null, 2).slice(0, 500);
          const { approved } = await confirmToolCall(tc.function.name, detail, reg.permission === 'delete');
          if (!approved) {
            result = `User declined: ${tc.function.name}`;
            this.postToolResult(tc, result);
            this.history.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
            continue;
          }
        }

        // Snapshot before write
        if (reg.permission === 'write' || reg.permission === 'delete') {
          if (typeof args['path'] === 'string') this.checkpoints.snapshotBefore(args['path']);
          if (typeof args['filepath'] === 'string') this.checkpoints.snapshotBefore(args['filepath']);
        }

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed);

        // Mark CodeLens pending for written files
        if (reg.permission === 'write' || reg.permission === 'delete') {
          const filePath = (args['path'] ?? args['filepath']) as string | undefined;
          if (filePath) this.codeLens.markPending([path.resolve(filePath)]);
        }
      } catch (err) {
        this.failureTracker.record();
        result = `Error: ${(err as Error).message}`;
      }

      this.postToolResult(tc, result);
    }
  }

  private postToolResult(tc: ToolCall, result: string): void {
    const preview = result.length > 200 ? result.slice(0, 200) + '…' : result;
    this.post({ type: 'token', text: `\n\n> **${tc.function.name}** → \`${preview}\`\n\n` });
    this.history.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
  }

  private streamOnce(
    request: ChatCompletionRequest,
    onToken: (token: string) => void,
  ): Promise<{ finishReason: string | null; toolCalls: ToolCall[] | null }> {
    return new Promise((resolve, reject) => {
      let capturedToolCalls: ToolCall[] | null = null;
      streamChatCompletion(
        this.backend.baseUrl(),
        request,
        {
          onToken,
          onDone: (reason) => resolve({ finishReason: reason, toolCalls: capturedToolCalls }),
          onError: reject,
          onToolCalls: (calls) => { capturedToolCalls = calls; },
        },
        this.cancelController?.signal,
      );
    });
  }

  // ── Persistence (v0.9) ────────────────────────────────────────────────────

  private persistHistory(): void {
    // Store only user/assistant text messages (not tool calls)
    const slim = this.history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
    void this.workspaceState.update(HISTORY_KEY, slim);
  }

  private restoreHistory(): void {
    const saved = this.workspaceState.get<Array<{ role: 'user' | 'assistant'; content: string }>>(HISTORY_KEY);
    if (!saved?.length) return;
    this.history = saved.map((m) => ({ role: m.role, content: m.content }));
    this.post({ type: 'historyRestore', messages: saved });
  }

  // ── Token budget (v0.9) ───────────────────────────────────────────────────

  private postTokenBudget(): void {
    const used = estimateTokens(this.history);
    const activeModel = this.config.models.find((m) => m.name === this.config.active_model);
    const max = activeModel?.num_ctx ?? 32768;
    this.post({ type: 'tokenBudget', used, max });
  }

  // ── HTML builder ──────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const distDir = path.join(this.extensionUri.fsPath, 'dist', 'webview');
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css'),
    );
    const nonce = getNonce();

    const templatePath = path.join(distDir, 'index.html');
    if (fs.existsSync(templatePath)) {
      return fs
        .readFileSync(templatePath, 'utf8')
        .replace(/\$\{cspSource\}/g, webview.cspSource)
        .replace(/\$\{nonce\}/g, nonce)
        .replace(/\$\{jsUri\}/g, jsUri.toString())
        .replace(/\$\{cssUri\}/g, cssUri.toString());
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

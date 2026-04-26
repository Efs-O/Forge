import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { BackendController } from '../backend/BackendController';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview, WebviewToHost } from './messageBridge';
import { streamChatCompletion } from '../llm/OpenAIClient';
import type { ChatCompletionRequest, ChatMessage, Mode, ToolCall } from '../llm/types';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { mergeSampling } from '../llm/SamplingMerge';
import { CheckpointStack } from '../checkpoint/CheckpointStack';
import { ToolRegistry, MODE_PERMISSIONS } from '../tools/ToolRegistry';
import { getLogger } from '../util/logger';

const log = getLogger();
const MAX_TOOL_ROUNDS = 10;

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'forge.sidebar';

  private view?: vscode.WebviewView;
  private cancelController: AbortController | null = null;
  private history: ChatMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: BackendController,
    private readonly config: ForgeConfig,
    private readonly checkpoints: CheckpointStack,
    private readonly toolRegistry: ToolRegistry,
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

  // ── Public methods delegated from extension.ts commands ──────────────────

  undo(): string[] {
    const restored = this.checkpoints.undo();
    this.post({ type: 'checkpointDismissed' });
    return restored;
  }

  keep(): void {
    this.checkpoints.keep();
    this.post({ type: 'checkpointDismissed' });
  }

  canUndo(): boolean {
    return this.checkpoints.canUndo();
  }

  newChat(): void {
    this.history = [];
    this.post({ type: 'newChat' });
    log.debug('[SidebarProvider] conversation reset');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

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
        } catch (err) {
          this.post({ type: 'error', message: (err as Error).message });
        }
        break;

      case 'keep':
        try {
          this.keep();
        } catch (err) {
          this.post({ type: 'error', message: (err as Error).message });
        }
        break;

      case 'newChat':
        this.newChat();
        break;
    }
  }

  private async handleSend(text: string, mode: Mode): Promise<void> {
    if (!this.backend.isReady()) {
      this.post({ type: 'error', message: 'Backend not ready. Check llama-server config.' });
      return;
    }

    this.cancelController = new AbortController();
    const turnId = `turn-${Date.now()}`;
    this.checkpoints.beginTurn(turnId);
    this.history.push({ role: 'user', content: text });

    log.debug(`[SidebarProvider] send mode=${mode} model=${this.config.active_model}`);

    try {
      await this.runAgentLoop(mode);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      const depthBefore = this.checkpoints.depth();
      this.checkpoints.commitTurn();
      if (this.checkpoints.depth() > depthBefore) {
        this.post({ type: 'checkpointReady' });
      }
    }
  }

  private async runAgentLoop(mode: Mode): Promise<void> {
    const allowed = MODE_PERMISSIONS[mode];
    const toolDefs = this.toolRegistry.definitions(allowed);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (this.cancelController?.signal.aborted) {
        this.post({ type: 'done', finishReason: 'cancelled' });
        return;
      }

      const messages = injectSystemPrompt([...this.history], mode);
      const base: ChatCompletionRequest = {
        model: this.config.active_model,
        messages,
        stream: true,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      };
      const request = mergeSampling(base, mode);

      let assistantContent = '';

      const { finishReason, toolCalls } = await this.streamOnce(request, (token) => {
        assistantContent += token;
        this.post({ type: 'token', text: token });
      });

      if (finishReason === 'tool_calls' && toolCalls?.length) {
        // Persist the assistant tool-call turn (null content is valid here).
        this.history.push({ role: 'assistant', content: null, tool_calls: toolCalls });
        await this.dispatchToolCalls(toolCalls, allowed);
        continue;
      }

      // Normal text completion.
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
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;

        // Snapshot before write operations (write_file path convention: args.path).
        const reg = this.toolRegistry.get(tc.function.name);
        if (reg?.permission === 'write' && typeof args['path'] === 'string') {
          this.checkpoints.snapshotBefore(args['path']);
        }

        result = await this.toolRegistry.dispatch(tc.function.name, args, allowed);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      // Surface tool result inline in the stream so the user can see it.
      const preview = result.length > 200 ? result.slice(0, 200) + '…' : result;
      this.post({ type: 'token', text: `\n\n> **${tc.function.name}** → \`${preview}\`\n\n` });

      this.history.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
        name: tc.function.name,
      });
    }
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
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

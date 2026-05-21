import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../llm/types';

const SESSIONS_DIR = path.join(os.homedir(), '.forge', 'sessions');

export class SessionLogger {
  private readonly filePath: string;
  private writtenCount = 0;
  private headerWritten = false;

  constructor(
    private readonly sessionId: string,
    private title: string,
    _model: string,
  ) {
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch { /* non-fatal */ }
    this.filePath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  }

  updateTitle(title: string): void { this.title = title; }

  flush(messages: ChatMessage[], model: string): void {

    if (!this.headerWritten) {
      this.append({ type: 'session_start', session_id: this.sessionId, title: this.title, model, timestamp_ms: Date.now() });
      this.headerWritten = true;
    }

    const newMessages = messages.slice(this.writtenCount);
    for (const msg of newMessages) {
      this.writtenCount++;
      if (msg.role === 'system') continue;

      if (msg.tool_calls?.length) {
        this.append({
          role: msg.role,
          content: null,
          tool_calls: msg.tool_calls.map((tc) => ({
            name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments) as unknown; } catch { return {}; } })(),
          })),
          timestamp_ms: Date.now(),
          model,
        });
        continue;
      }

      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p) => p.type === 'text')
                .map((p) => ('text' in p ? p.text : ''))
                .join('\n')
            : null;

      if (!content) continue;

      const line: Record<string, unknown> = { role: msg.role, content, timestamp_ms: Date.now(), model };
      if (msg.reasoning) line['reasoning'] = msg.reasoning;
      this.append(line);
    }
  }

  private append(obj: Record<string, unknown>): void {
    try { fs.appendFileSync(this.filePath, JSON.stringify(obj) + '\n', 'utf8'); } catch { /* non-fatal */ }
  }
}

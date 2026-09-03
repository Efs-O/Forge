import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { VoiceAuditEvent, VoiceAuditSink } from './VoiceAudit';

/**
 * Appends voice audit rows as JSONL under `~/.forge/sessions/`.
 *
 * A separate file from the per-conversation session logs, and not by preference:
 * a voice operation starts before any conversation is known, and the operations
 * most worth reading later are the REJECTED ones, which never bind to a
 * conversation at all. Routing those into a conversation log would mean the
 * failures vanish and only the successes are recorded -- the exact bias that
 * makes a log useless for diagnosis.
 *
 * `operation_id` is the join key: one grep reconstructs an operation from
 * ingress to admission, and pairs it with the prompt in the conversation log.
 *
 * Writes are best-effort and synchronous-append. Audio is deliberately not
 * retained, so if a row is not written here the origin of a voice turn is gone
 * the moment it completes -- but a failed write must never take down the turn
 * that produced it.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §20.1.
 */
export class VoiceAuditFileSink implements VoiceAuditSink {
  private readonly filePath: string;
  private warned = false;

  constructor(
    baseDir: string = path.join(os.homedir(), '.forge', 'sessions'),
    private readonly onError?: (message: string) => void,
  ) {
    this.filePath = path.join(baseDir, 'voice.jsonl');
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch {
      /* reported on first write instead */
    }
  }

  write(event: VoiceAuditEvent): void {
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      // Once per session: a broken path would otherwise emit a notification per
      // utterance, which trains the user to ignore all of them.
      if (this.warned) return;
      this.warned = true;
      this.onError?.(
        `Forge: voice audit log could not be written (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
  }
}

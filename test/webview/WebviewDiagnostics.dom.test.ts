// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebviewDiagnosticMsg } from '../../src/sidebar/messageBridge';

const bridgeMessages: WebviewDiagnosticMsg[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: () => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => undefined });

let WebviewDiagnostics: typeof import('../../webview-ui/src/WebviewDiagnostics').WebviewDiagnostics;

beforeAll(async () => {
  ({ WebviewDiagnostics } = await import('../../webview-ui/src/WebviewDiagnostics'));
});

afterEach(() => bridgeMessages.splice(0));

describe('WebviewDiagnostics', () => {
  it('keeps a bounded content-free ring and reports aggregate stream counts', () => {
    const diagnostics = new WebviewDiagnostics((message) => bridgeMessages.push(message));
    const stop = diagnostics.start();
    diagnostics.recordState({
      activeConversationId: 'conversation-1',
      displayedMessages: 36,
      queuedPrompts: 1,
      streaming: true,
      prefillPending: false,
    });
    diagnostics.recordHostMessage({
      type: 'token',
      text: 'SECRET_GENERATED_CONTENT',
      conversationId: 'conversation-1',
    });
    diagnostics.recordHostMessage({
      type: 'reasoningToken',
      text: 'SECRET_REASONING_CONTENT',
      conversationId: 'conversation-1',
    });
    for (let index = 0; index < 250; index++) {
      diagnostics.recordHostMessage({
        type: 'notice',
        message: `SECRET_NOTICE_${index}`,
        conversationId: 'conversation-1',
      });
    }
    diagnostics.recordInputChange(1234);
    diagnostics.capture('react-error', new Error('Maximum update depth exceeded'), 'at App');
    stop();

    const crash = bridgeMessages.find((message) => message.kind === 'react-error')!;
    expect(crash.summary.hostMessages).toBe(252);
    expect(crash.summary.messageTypes).toMatchObject({ token: 1, reasoningToken: 1, notice: 250 });
    expect(crash.recent).toHaveLength(200);
    expect(JSON.stringify(crash)).not.toContain('SECRET_GENERATED_CONTENT');
    expect(JSON.stringify(crash)).not.toContain('SECRET_REASONING_CONTENT');
    expect(JSON.stringify(crash)).not.toContain('SECRET_NOTICE');
  });
});

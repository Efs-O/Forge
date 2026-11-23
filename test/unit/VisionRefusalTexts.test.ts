/**
 * The four vision refusals, pinned whole (plan Lane B4).
 *
 * Each one used to name only llama.cpp's `mmproj_path`. A model served by
 * another provider read that as a Forge bug and went looking for a projector
 * file its provider has no notion of, so every one of them now says which fix
 * applies to which kind of backend. The wording IS the fix, so it is asserted
 * in full, for one model name, in one place.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';

// The desktop family builds its tools from the PowerShell driver singleton.
// Only the refusal text is under test here, so the driver never runs.
vi.mock('../../src/tools/desktop/PowerShellDesktopDriver', () => ({
  getDesktopDriver: () => ({ capture: vi.fn(), listWindows: vi.fn() }),
}));

import { visionUnavailableMessage } from '../../src/tools/imageTool';
import { videoUnavailableMessage } from '../../src/tools/videoTool';
import { visionRefusal } from '../../src/tools/browser/browserTools';
import { makeDesktopTools } from '../../src/tools/desktop/desktopTools';

const MODEL = 'm';

function desktopCaptureRefusal(): string {
  const capture = makeDesktopTools(() => ({}) as unknown as ForgeConfig).find(
    (tool) => tool.definition.function.name === 'desktop_capture',
  );
  const refusal = capture?.requiresVision?.(MODEL);
  if (typeof refusal !== 'string') throw new Error('desktop_capture carries no vision refusal');
  return refusal;
}

describe('vision refusals name both fixes', () => {
  it('view_image', () => {
    expect(visionUnavailableMessage(MODEL)).toBe(
      'Error: view_image needs a vision model; the active model "m" is not configured for vision ' +
        '(llama.cpp: set mmproj_path; other providers: declare the vision capability). Do not try ' +
        'to read the image with another tool: report that you cannot see it and ask the user to ' +
        'switch to a vision-capable model.',
    );
  });

  it('view_video', () => {
    expect(videoUnavailableMessage(MODEL)).toBe(
      'Error: view_video needs a vision model; the active model "m" is not configured for vision ' +
        '(llama.cpp: set mmproj_path; other providers: declare the vision capability). Do not try ' +
        'to read the video with another tool: report that you cannot see it and ask the user to ' +
        'switch to a vision-capable model.',
    );
  });

  it('the browser screenshot tools', () => {
    expect(visionRefusal(MODEL)).toBe(
      'Error: this tool needs a vision model; the active model "m" is not configured for vision ' +
        '(llama.cpp: set mmproj_path; other providers: declare the vision capability). For webpage ' +
        'appearance, use render_html_to_image console output; to inspect screenshots, ask the user ' +
        'to switch to a vision-capable model.',
    );
  });

  it('desktop_capture', () => {
    expect(desktopCaptureRefusal()).toBe(
      'Error: desktop_capture needs a vision model; the active model "m" is not configured for ' +
        'vision (llama.cpp: set mmproj_path; other providers: declare the vision capability). Ask ' +
        'the user to switch to a vision-capable model before inspecting desktop captures.',
    );
  });

  it('still names mmproj_path, so a llama.cpp reader keeps the one fix it needs', () => {
    for (const message of [
      visionUnavailableMessage(MODEL),
      videoUnavailableMessage(MODEL),
      visionRefusal(MODEL),
      desktopCaptureRefusal(),
    ]) {
      expect(message).toContain('mmproj_path');
      expect(message).toContain('declare the vision capability');
    }
  });
});

import * as fs from 'fs/promises';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';

/**
 * Input validation shared by `render_html_to_image`'s two modes: the HTML size
 * cap, the workspace file read, and the viewport bounds. Kept apart from the
 * modes themselves, which differ in everything after the input is accepted
 * (image saves and delivers; preview returns to the model only).
 */

/** Guards against a pathological input rather than a plausible one. */
export const MAX_HTML_BYTES = 10 * 1024 * 1024;
export const MIN_VIEWPORT_PX = 1;
export const MAX_VIEWPORT_PX = 8_192;

export function checkHtmlBytes(html: string, what: string): void {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    throw new Error(
      `render_html_to_image: ${what} is ${bytes.toLocaleString()} bytes; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
    );
  }
}

/** Open a workspace text file and read at most the HTML limit plus one byte. */
export async function readWorkspaceTextFileCapped(
  rawPath: string,
  kind: 'html' | 'shader',
): Promise<string> {
  const file = await resolveRealWorkspacePath(rawPath);
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`render_html_to_image: not a file: ${rawPath}`);
    }
    if (stat.size > MAX_HTML_BYTES) {
      const message =
        kind === 'html'
          ? `html file is ${stat.size.toLocaleString()} bytes; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`
          : `shader file exceeds ${MAX_HTML_BYTES} bytes.`;
      throw new Error(`render_html_to_image: ${message}`);
    }

    const buffer = Buffer.alloc(MAX_HTML_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_HTML_BYTES) {
      const message =
        kind === 'html'
          ? `html file grew to ${total.toLocaleString()} bytes while being read; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`
          : 'shader file grew beyond the 10 MB limit while being read.';
      throw new Error(`render_html_to_image: ${message}`);
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Read a workspace `.html` file under the size cap. */
export async function readHtmlFile(rawPath: string): Promise<string> {
  return readWorkspaceTextFileCapped(rawPath, 'html');
}

export function readViewportPx(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`render_html_to_image: ${name} must be an integer.`);
  }
  if (value < MIN_VIEWPORT_PX || value > MAX_VIEWPORT_PX) {
    throw new Error(
      `render_html_to_image: ${name} is ${value}; the range is ${MIN_VIEWPORT_PX}–${MAX_VIEWPORT_PX}.`,
    );
  }
  return value;
}

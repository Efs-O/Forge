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

/** Read a workspace `.html` file under the size cap. */
export async function readHtmlFile(rawPath: string): Promise<string> {
  const file = await resolveRealWorkspacePath(rawPath);
  const stat = await fs.stat(file);
  if (!stat.isFile()) {
    throw new Error(`render_html_to_image: not a file: ${rawPath}`);
  }
  if (stat.size > MAX_HTML_BYTES) {
    throw new Error(
      `render_html_to_image: html file is ${stat.size.toLocaleString()} bytes; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
    );
  }
  const html = await fs.readFile(file, 'utf8');
  // Re-check after the read: `stat` is a snapshot, and a file that grew (or
  // was swapped for a symlink target) between `stat` and `readFile` would
  // otherwise slip past the cap. The byte length of the decoded string is what
  // Chrome will actually be handed.
  const readBytes = Buffer.byteLength(html, 'utf8');
  if (readBytes > MAX_HTML_BYTES) {
    throw new Error(
      `render_html_to_image: html file grew to ${readBytes.toLocaleString()} bytes while being read; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
    );
  }
  return html;
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

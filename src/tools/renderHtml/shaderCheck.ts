import type { BrowserChannel } from '../browser/BrowserSessionManager';
import { readWorkspaceTextFileCapped } from './htmlInput';
import { PREVIEW_LAUNCH_ARGS, PREVIEW_ORIGIN, withRenderBrowser } from './renderEngine';
import { extractShaders, mappedPosition, type ShaderCandidate } from './shaderExtract';

const SHADER_CHECK_TIMEOUT_MS = 30_000;
const WGSL_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
  '--enable-unsafe-swiftshader',
] as const;
const GLSL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader'] as const;

export interface ShaderCheckOptions {
  channel: BrowserChannel;
  timeoutMs?: number;
}

export async function runShaderCheck(
  filePath: string,
  options: ShaderCheckOptions,
  abortSignal?: AbortSignal,
): Promise<string> {
  const extension = filePath.toLowerCase().split('.').at(-1) ?? '';
  if (!['wgsl', 'glsl', 'vert', 'frag', 'js', 'mjs', 'ts', 'html'].includes(extension)) {
    throw new Error(
      'render_html_to_image: shader_check path must end in .wgsl, .glsl, .vert, .frag, .js, .mjs, .ts, or .html.',
    );
  }
  const source = await readWorkspaceTextFileCapped(filePath, 'shader');
  const extracted = extractShaders(filePath, source);
  if (extracted.shaders.length === 0 && extracted.skipped.length === 0) {
    return 'Shader check: No shaders found.';
  }
  const outcomes =
    extracted.shaders.length === 0 ? [] : await compile(extracted.shaders, options, abortSignal);
  const lines = ['Shader check (shader text only; the workspace page was not opened):'];
  outcomes.forEach((result, index) => {
    const shader = extracted.shaders[index]!;
    lines.push(`${shader.label}: ${result.length} compiler message(s).`);
    for (const message of result) {
      const position = mappedPosition(shader, message.line, message.column);
      lines.push(`- ${filePath}:${position.line}:${position.column}: ${message.text}`);
    }
  });
  for (const skipped of extracted.skipped) {
    lines.push(`- ${filePath}:${skipped.line}: skipped: ${skipped.reason}.`);
  }
  return lines.join('\n');
}

interface CompilerMessage {
  line: number;
  column: number;
  text: string;
}

async function compile(
  shaders: ShaderCandidate[],
  options: ShaderCheckOptions,
  abortSignal?: AbortSignal,
): Promise<CompilerMessage[][]> {
  const results = new Array<CompilerMessage[]>(shaders.length);
  for (const language of ['wgsl', 'glsl'] as const) {
    const indexes = shaders.flatMap((shader, index) =>
      shader.language === language ? [index] : [],
    );
    if (indexes.length === 0) continue;
    const compiled = await compileBatch(
      indexes.map((index) => shaders[index]!),
      language,
      options,
      abortSignal,
    );
    indexes.forEach((index, resultIndex) => {
      results[index] = compiled[resultIndex]!;
    });
  }
  return results;
}

async function compileBatch(
  shaders: ShaderCandidate[],
  language: 'wgsl' | 'glsl',
  options: ShaderCheckOptions,
  abortSignal?: AbortSignal,
): Promise<CompilerMessage[][]> {
  return withRenderBrowser(
    {
      channel: options.channel,
      timeoutMs: options.timeoutMs ?? SHADER_CHECK_TIMEOUT_MS,
      // SwiftShader keeps shader checks off the NVIDIA GPU used by local models.
      // WGSL needs its WebGPU adapter flag; ANGLE's SwiftShader flag disables that adapter.
      args: [...PREVIEW_LAUNCH_ARGS, ...(language === 'wgsl' ? WGSL_ARGS : GLSL_ARGS)],
    },
    abortSignal,
    async (browser) => {
      const context = await browser.newContext({ javaScriptEnabled: true });
      await context.route('**/*', async (route) => {
        if (route.request().url() === `${PREVIEW_ORIGIN}/`) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: COMPILER_PAGE,
          });
        } else {
          await route.abort();
        }
      });
      try {
        const page = await context.newPage();
        await page.goto(`${PREVIEW_ORIGIN}/`, { waitUntil: 'load' });
        return await page.evaluate(
          async (items) => {
            type GpuDevice = {
              createShaderModule: (source: { code: string }) => {
                getCompilationInfo: () => Promise<{
                  messages: Array<{
                    type: string;
                    lineNum: number;
                    linePos: number;
                    message: string;
                  }>;
                }>;
              };
              destroy: () => void;
            };
            const pageGlobals = globalThis as unknown as {
              navigator?: {
                gpu?: {
                  requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDevice> } | null>;
                };
              };
              document: {
                createElement: (tag: string) => {
                  getContext: (name: string) => WebGlContext | null;
                };
              };
            };
            type WebGlContext = {
              VERTEX_SHADER: number;
              FRAGMENT_SHADER: number;
              COMPILE_STATUS: number;
              createShader: (type: number) => object | null;
              shaderSource: (shader: object, source: string) => void;
              compileShader: (shader: object) => void;
              getShaderInfoLog: (shader: object) => string | null;
              getShaderParameter: (shader: object, parameter: number) => boolean;
              deleteShader: (shader: object) => void;
            };
            const results: Array<Array<{ line: number; column: number; text: string }>> = [];
            for (const item of items) {
              if (item.language === 'wgsl') {
                const gpu = pageGlobals.navigator?.gpu;
                const adapter = await gpu?.requestAdapter();
                if (!adapter) {
                  results.push([
                    { line: 1, column: 1, text: 'WebGPU software adapter unavailable.' },
                  ]);
                  continue;
                }
                const device = await adapter.requestDevice();
                const module = device.createShaderModule({ code: item.code });
                const info = await module.getCompilationInfo();
                results.push(
                  info.messages.map(
                    (message: {
                      type: string;
                      lineNum: number;
                      linePos: number;
                      message: string;
                    }) => ({
                      line: message.lineNum || 1,
                      column: message.linePos || 1,
                      text: `${message.type}: ${message.message}`,
                    }),
                  ),
                );
                device.destroy();
              } else {
                const gl = pageGlobals.document.createElement('canvas').getContext('webgl2');
                if (!gl) {
                  results.push([{ line: 1, column: 1, text: 'WebGL2 compiler unavailable.' }]);
                  continue;
                }
                const type = item.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
                const shader = gl.createShader(type);
                if (!shader) {
                  results.push([{ line: 1, column: 1, text: 'Could not create WebGL2 shader.' }]);
                  continue;
                }
                gl.shaderSource(shader, item.code);
                gl.compileShader(shader);
                const log = gl.getShaderInfoLog(shader) ?? '';
                const messages = log
                  .split('\n')
                  .filter(Boolean)
                  .map((text: string) => {
                    const match = /(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/.exec(text);
                    const line = Number(match?.[1] ?? 1);
                    const token = /'([^']+)'/.exec(text)?.[1];
                    const sourceLine = item.code.split('\n')[line - 1] ?? '';
                    const tokenOffset = token ? sourceLine.indexOf(token) : -1;
                    return { line, column: tokenOffset >= 0 ? tokenOffset + 1 : 1, text };
                  });
                results.push(gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? [] : messages);
                gl.deleteShader(shader);
              }
            }
            return results;
          },
          shaders.map(({ language, stage, code }) => ({ language, stage, code })),
        );
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  );
}

const COMPILER_PAGE = '<!doctype html><meta charset="utf-8"><title>Forge shader compiler</title>';

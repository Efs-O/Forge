export type ShaderLanguage = 'wgsl' | 'glsl';
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

export interface ShaderCandidate {
  label: string;
  language: ShaderLanguage;
  stage?: ShaderStage;
  code: string;
  startOffset: number;
  startLine: number;
  startColumn: number;
}

export interface SkippedShader {
  line: number;
  reason: string;
}

export interface ExtractedShaders {
  shaders: ShaderCandidate[];
  skipped: SkippedShader[];
}

const WGSL_MARKER = /@(vertex|fragment|compute)\b/;
const GLSL_MARKER = /\bvoid\s+main\s*\(/;

export function extractShaders(filePath: string, source: string): ExtractedShaders {
  const extension = filePath.toLowerCase().split('.').at(-1) ?? '';
  if (extension === 'wgsl') {
    return { shaders: [candidate('shader 1', 'wgsl', source, 0, source)], skipped: [] };
  }
  if (['glsl', 'vert', 'frag'].includes(extension)) {
    return {
      shaders: [candidate('shader 1', 'glsl', source, 0, source, glslStage(extension, source))],
      skipped: [],
    };
  }

  const shaders: ShaderCandidate[] = [];
  const skipped: SkippedShader[] = [];
  const seen = new Set<number>();
  const add = (
    label: string,
    code: string,
    offset: number,
    forced?: ShaderLanguage,
    stageOverride?: ShaderStage,
  ) => {
    if (seen.has(offset)) return;
    const language = forced ?? languageOf(code);
    if (!language) return;
    if (code.includes('${')) {
      skipped.push({
        line: lineAt(source, offset + code.indexOf('${')),
        reason: 'template literal has ${...} interpolation',
      });
      seen.add(offset);
      return;
    }
    const stage = language === 'glsl' ? (stageOverride ?? glslStage(extension, code)) : undefined;
    shaders.push(
      candidate(`shader ${shaders.length + 1} (${label})`, language, code, offset, source, stage),
    );
    seen.add(offset);
  };

  const typedBlock =
    /<script\b[^>]*type\s*=\s*["']x-shader\/(wgsl|glsl|x-vertex|x-fragment|vertex|fragment|compute)["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of source.matchAll(typedBlock)) {
    const offset = (match.index ?? 0) + match[0].indexOf(match[2] ?? '');
    const type = (match[1] ?? '').toLowerCase();
    const stage = type.includes('vertex')
      ? 'vertex'
      : type.includes('fragment')
        ? 'fragment'
        : undefined;
    add(
      'script',
      match[2] ?? '',
      offset,
      type === 'wgsl' || type === 'compute' ? 'wgsl' : 'glsl',
      stage,
    );
  }

  const literal = /(`(?:\\[\s\S]|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of source.matchAll(literal)) {
    const raw = match[0];
    const code = raw.slice(1, -1);
    add('string literal', code, (match.index ?? 0) + 1);
  }
  return { shaders, skipped };
}

export function sourcePosition(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  return { line, column: before.length - (before.lastIndexOf('\n') + 1) + 1 };
}

export function mappedPosition(
  shader: ShaderCandidate,
  line: number,
  column: number,
): { line: number; column: number } {
  if (line <= 1) return { line: shader.startLine, column: shader.startColumn + column - 1 };
  return { line: shader.startLine + line - 1, column };
}

function candidate(
  label: string,
  language: ShaderLanguage,
  code: string,
  offset: number,
  source: string,
  stage?: ShaderStage,
): ShaderCandidate {
  const position = sourcePosition(source, offset);
  return {
    label,
    language,
    ...(stage ? { stage } : {}),
    code,
    startOffset: offset,
    startLine: position.line,
    startColumn: position.column,
  };
}

function languageOf(code: string): ShaderLanguage | undefined {
  if (WGSL_MARKER.test(code)) return 'wgsl';
  if (GLSL_MARKER.test(code)) return 'glsl';
  return undefined;
}

function glslStage(extension: string, code: string): ShaderStage {
  if (extension === 'vert') return 'vertex';
  if (extension === 'frag') return 'fragment';
  return /\bgl_Position\b/.test(code) ? 'vertex' : 'fragment';
}

function lineAt(source: string, offset: number): number {
  return sourcePosition(source, offset).line;
}

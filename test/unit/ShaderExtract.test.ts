import { describe, expect, it } from 'vitest';
import { extractShaders, mappedPosition } from '../../src/tools/renderHtml/shaderExtract';

describe('shader extraction and source mapping', () => {
  it('finds WGSL in a JS template and maps compiler lines to the file', () => {
    const source = [
      'const shader = `',
      '@vertex fn main() -> @builtin(position) vec4f {',
      '  let ref = vec4f(0.0);',
      '  return ref;',
      '}`;',
    ].join('\n');
    const { shaders, skipped } = extractShaders('page.js', source);
    expect(skipped).toEqual([]);
    expect(shaders).toHaveLength(1);
    expect(shaders[0]?.language).toBe('wgsl');
    expect(mappedPosition(shaders[0]!, 3, 7)).toEqual({ line: 3, column: 7 });
  });

  it('reports interpolated shader templates as skipped at their source line', () => {
    const source = [
      'const shader = `',
      '@compute @workgroup_size(1) fn main() {',
      ' let x = ${value};',
      '}`;',
    ].join('\n');
    const result = extractShaders('page.ts', source);
    expect(result.shaders).toEqual([]);
    expect(result.skipped).toEqual([
      {
        line: 3,
        reason:
          'template literal has ${...} interpolation; write the assembled shader to a .wgsl or .glsl file and run shader_check on it',
      },
    ]);
  });

  it('extracts typed shader script blocks and standalone shader files', () => {
    const html =
      '<script type="x-shader/wgsl">\n@compute @workgroup_size(1) fn main() {}\n</script>';
    expect(extractShaders('page.html', html).shaders[0]).toMatchObject({
      language: 'wgsl',
      startLine: 1,
      startColumn: 30,
    });
    expect(
      extractShaders('clean.wgsl', '@compute @workgroup_size(1) fn main() {}').shaders,
    ).toHaveLength(1);
    expect(
      extractShaders('broken.frag', 'void main() { gl_FragColor = vec4(1.0) }').shaders[0],
    ).toMatchObject({
      language: 'glsl',
      stage: 'fragment',
    });
  });
});

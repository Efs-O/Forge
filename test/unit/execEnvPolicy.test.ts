import { describe, expect, it } from 'vitest';
import { MAX_ENV_VARS, validateExecEnv } from '../../src/tools/execEnvPolicy';

describe('validateExecEnv', () => {
  it('accepts the VSIX install env', () => {
    const result = validateExecEnv({ ELECTRON_RUN_AS_NODE: '1' });
    expect(result.ok).toBe(true);
    expect(result.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('accepts a normal, harmless env', () => {
    const result = validateExecEnv({ CI: 'true', NODE_ENV: 'test', MY_PROXY: 'http://x:1' });
    expect(result.ok).toBe(true);
    expect(result.env).toEqual({ CI: 'true', NODE_ENV: 'test', MY_PROXY: 'http://x:1' });
  });

  it('treats an omitted env as an empty, valid env', () => {
    expect(validateExecEnv(undefined)).toEqual({ ok: true, env: {} });
  });

  it('treats an empty object as valid', () => {
    expect(validateExecEnv({})).toEqual({ ok: true, env: {} });
  });

  describe('blocks dangerous names (case-insensitive)', () => {
    const blocked = [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_COMPILE_CACHE',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'LD_DEBUG',
      'PYTHONSTARTUP',
      'PYTHONPATH',
      'PYTHONHOME',
      'JAVA_TOOL_OPTIONS',
      '_JAVA_OPTIONS',
      'CLASSPATH',
      'JDK_JAVA_OPTIONS',
      'DOTNET_STARTUP_HOOKS',
      'DOTNET_ADDITIONAL_DEPS',
      'RUBYOPT',
      'PERL5LIB',
      'PERLLIB',
      'PERL5OPT',
      'BASH_ENV',
      'ENV',
      'PATH',
      'PATHEXT',
      'COMSPEC',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TMP',
      'TMPDIR',
      'TEMP',
      'GIT_DIR',
      'GIT_WORK_TREE',
      'NPM_EXECPATH',
    ];

    it.each(blocked)('refuses %s', (name) => {
      const result = validateExecEnv({ [name]: 'x' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(name);
    });

    it('is case-insensitive', () => {
      expect(validateExecEnv({ Node_Options: 'x' }).ok).toBe(false);
      expect(validateExecEnv({ Path: 'x' }).ok).toBe(false);
      expect(validateExecEnv({ node_options: 'x' }).ok).toBe(false);
    });
  });

  describe('blocks dangerous prefixes', () => {
    const blocked = [
      'npm_config_registry',
      'npm_lifecycle_script',
      'git_config_global',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'dyld_some_new_var',
    ];

    it.each(blocked)('refuses %s', (name) => {
      const result = validateExecEnv({ [name]: 'x' });
      expect(result.ok).toBe(false);
    });
  });

  describe('rejects malformed keys', () => {
    it.each(['', 'has space', 'a;b', 'semi;colon', 'dollar$var', '123leading'])('refuses %j', (key) => {
      expect(validateExecEnv({ [key]: 'x' }).ok).toBe(false);
    });

    it('refuses a key longer than 128 characters', () => {
      const longKey = 'A'.repeat(200);
      expect(validateExecEnv({ [longKey]: 'x' }).ok).toBe(false);
    });

    it('accepts a key of exactly 128 characters', () => {
      const key = 'A'.repeat(128);
      expect(validateExecEnv({ [key]: 'x' }).ok).toBe(true);
    });
  });

  it('rejects a non-string value', () => {
    const result = validateExecEnv({ FOO: 1 } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must be a string');
  });

  it('rejects an oversized value', () => {
    const result = validateExecEnv({ FOO: 'x'.repeat(8193) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exceeds');
  });

  it('accepts a value of exactly the maximum length', () => {
    expect(validateExecEnv({ FOO: 'x'.repeat(8192) }).ok).toBe(true);
  });

  it('rejects more than the maximum number of vars', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < MAX_ENV_VARS + 1; i += 1) tooMany[`V${i}`] = 'x';
    expect(validateExecEnv(tooMany).ok).toBe(false);
  });

  it('accepts exactly the maximum number of vars', () => {
    const exact: Record<string, string> = {};
    for (let i = 0; i < MAX_ENV_VARS; i += 1) exact[`V${i}`] = 'x';
    expect(validateExecEnv(exact).ok).toBe(true);
  });

  it('rejects a non-object env', () => {
    expect(validateExecEnv('FOO=bar' as unknown as Record<string, unknown>).ok).toBe(false);
    expect(validateExecEnv(['FOO'] as unknown as Record<string, unknown>).ok).toBe(false);
    expect(validateExecEnv(null as unknown as Record<string, unknown>).ok).toBe(false);
  });
});

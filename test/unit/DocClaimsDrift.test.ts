/**
 * The three checks `AiSetupDoc.test.ts` and `CommandsDocDrift.test.ts` leave
 * open, and the one neither of them could do:
 *
 * 1. Every YAML example `README.md` and `AI_SETUP.md` shows has to parse with
 *    `ForgeConfigSchema`. Four store-page examples held a `models:` map shape
 *    the schema refuses, so a new user's first config failed on key names that
 *    were all correct (docs audit 2026-10-27, D-1 to D-4).
 * 2. Every slash command `README.md` lists has to be a real trigger, and every
 *    trigger has to be listed — `/link`, `/chatMode` and `/system` shipped for
 *    releases without appearing on the page (D-9, F-1).
 * 3. Every tool name written into text the model reads has to be registered.
 *    `find_references` survived in a description a month after the tool was
 *    retired (A-1).
 * 4. Every `forge.*` key named in an active doc has to be in the manifest —
 *    four shipped settings had no mention anywhere (E-2, E-3).
 *
 * Historical reports under `docs/` are deliberately out of scope: they record
 * what was true when they were written, and their retired names are part of the
 * record, not drift.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PARTIAL_MARKER,
  isPartialExample,
  validateConfigExample,
  yamlBlocks,
} from '../support/docConfigExamples';

const root = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const pkg = JSON.parse(read('package.json')) as {
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, unknown> };
  };
};

// ── 1. config examples ────────────────────────────────────────────────────────

describe('config examples in the store page and the setup guide', () => {
  for (const file of ['README.md', 'AI_SETUP.md']) {
    it(`every yaml block in ${file} parses with ForgeConfigSchema`, () => {
      const blocks = yamlBlocks(read(file));
      expect(blocks.length).toBeGreaterThan(0);
      const failures = blocks
        .filter((block) => block.content.trim().length > 0)
        .flatMap((block) =>
          validateConfigExample(block.content).map(
            (error) => `${file}:${String(block.fenceLine)} ${error}`,
          ),
        );
      expect(failures).toEqual([]);
    });
  }

  it('marks a fragment as partial instead of letting it read like a whole config', () => {
    const unmarked = ['README.md', 'AI_SETUP.md'].flatMap((file) =>
      yamlBlocks(read(file))
        .filter((block) => !isPartialExample(block.content))
        .filter((block) => validateConfigExample(block.content).length > 0)
        .map((block) => `${file}:${String(block.fenceLine)}`),
    );
    expect(unmarked).toEqual([]);
  });
});

// ── 2. slash commands ─────────────────────────────────────────────────────────

describe('README.md slash table', () => {
  const section = ((): string => {
    const doc = read('README.md');
    const start = doc.indexOf('## Slash Commands');
    const end = doc.indexOf('\n## ', start + 5);
    expect(start).toBeGreaterThan(-1);
    return doc.slice(start, end);
  })();

  const listed = new Set(
    Array.from(section.matchAll(/^\|\s*`(\/[A-Za-z][A-Za-z0-9]*)`/gm), (match) => match[1]!),
  );

  const triggers = new Set(
    Array.from(
      read('webview-ui/src/slashCommands.ts').matchAll(/trigger: '([A-Za-z][A-Za-z0-9]*)'/g),
      (match) => match[1]!,
    ),
  );

  // `/initForge` is the alias of `/init` and is named in the `/init` row.
  const expected = new Set([...triggers].filter((trigger) => trigger !== 'initForge'));

  it('lists every trigger the sidebar handles', () => {
    expect([...expected].map((trigger) => `/${trigger}`).filter((row) => !listed.has(row))).toEqual(
      [],
    );
  });

  it('lists no command the sidebar does not handle', () => {
    expect([...listed].filter((row) => !expected.has(row.slice(1)))).toEqual([]);
  });

  it('says what the alias is for', () => {
    expect(section).toContain('/initForge');
  });
});

// ── 3. tool names in text the model reads ─────────────────────────────────────

describe('tool names in model-facing text', () => {
  const toolFiles = ((): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (entry.name.endsWith('.ts')) out.push(relative);
      }
    };
    walk('src/tools');
    return out;
  })();

  const registered = new Set<string>();
  for (const file of toolFiles) {
    for (const match of read(file).matchAll(/name: '([a-z][a-z0-9]+(?:_[a-z0-9]+)*)'/g)) {
      registered.add(match[1]!);
    }
  }

  const sourceFiles = ((): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (entry.name.endsWith('.ts')) out.push(relative);
      }
    };
    walk('src');
    return out;
  })();

  /**
   * Names the tool and config sources themselves declare - an object key, an enum value,
   * an argument read out of `args`. A name the tool surface declares is not a
   * tool claim: `code_actions` is an operation value in `codeIntelTool.ts`, and
   * `expected_lines` is an argument of `apply_line_edits` that
   * `builtinTools.ts` mentions in passing. Collected from the sources instead
   * of hand-typed, so the allowlist does not grow every time a description
   * names an argument.
   */
  const declaredNames = new Set<string>();
  for (const file of sourceFiles) {
    const source = read(file);
    for (const match of source.matchAll(/^\s*([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\s*:/gm)) {
      declaredNames.add(match[1]!);
    }
    for (const match of source.matchAll(/['\"]([a-z][a-z0-9]+(?:_[a-z0-9]+)+)['\"]/g)) {
      declaredNames.add(match[1]!);
    }
  }

  /**
   * Names that may appear in model-facing text without being a live tool: the
   * argument and config names the prose legitimately talks about
   * (`max_output_chars` is an argument of `monitor_execution`, not a tool).
   * The retired names read from `src/sidebar/retiredTools.ts` are allowed only
   * in prose, not in a description — see the two tests below.
   */
  const retiredNames = new Set<string>(
    Array.from(
      read('src/sidebar/retiredTools.ts').matchAll(
        /^\s\s([a-z][a-z0-9]+(?:_[a-z0-9]+)+): \{ tool:/gm,
      ),
      (match) => match[1]!,
    ),
  );
  const argumentNames = new Set<string>([
    // Tool arguments named in descriptions and refusal text.
    'max_output_chars',
    'head_lines',
    'tail_lines',
    'output_stream',
    'background',
    'notify_on_exit',
    'suggested_next_wait_ms',
    'max_results',
    'max_frames',
    'frame_max_dimension',
    'full_page',
    'wait_ms',
    'start_line',
    'end_line',
    'max_entries',
    'reference_paths',
    'max_chars',
    'max_tokens',
    'num_ctx',
    // Config keys the same text explains.
    'n_gpu_layers',
    'mmproj_path',
    'start_command',
    'stop_command',
    'unload_path',
    'max_result_chars',
    'idle_timeout_ms',
    'request_timeout_ms',
    'retain_days',
    'model_dirs',
    'templates_dir',
    // Job action and schedule values the job tool's text talks about.
    'run_now',
    'on_change',
    // Words the prose uses that are neither a tool nor an argument:
    // `project_instructions` is FORGE.md and `selected_code` is what
    // `get_editor_context` reports, not a tool. `hf_parallel_dl` is the downloader
    // the `hf-download` skill ships and the starter file names.
    'project_instructions',
    'selected_code',
    'hf_parallel_dl',
    // Transcript and protocol vocabulary, not Forge tool names.
    'tool_call_id',
    'chat_id',
    'task_id',
    'tool_groups',
    'NO_COLOR',
  ]);

  /**
   * A retired name may still be written in the starter file or a prompt
   * template, where the surrounding text says it was replaced. It may not
   * appear in a tool description, which the model reads as current: that is
   * how `find_references` lived on in a description a month after the tool
   * went away (audit finding A-1).
   */
  const descriptionAllowlist = new Set<string>([...argumentNames, ...declaredNames]);
  const proseAllowlist = new Set<string>([...descriptionAllowlist, ...retiredNames]);

  /**
   * Only the text a model actually reads: tool and parameter descriptions,
   * refusal alternatives, validation messages. Code comments are not
   * model-facing and are not scanned, which is what keeps an API response
   * field name such as `organic_results` out of this check.
   */
  const modelFacingText = (source: string): string => {
    const lines = source.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const open =
        /^(\s*)(?:description|note|alternative|usage|summary|hint|reason|message)\s*:/.exec(
          lines[i]!,
        );
      if (!open) continue;
      const indent = open[1]!.length;
      out.push(lines[i]!);
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]!;
        if (!line.trim()) break;
        // A key at this level or shallower ends the string.
        if (new RegExp(`^\\s{0,${String(indent)}}[A-Za-z_$][A-Za-z0-9_$]*\\s*:`).test(line)) break;
        out.push(line);
      }
    }
    return out.join('\n');
  };

  const starterContent = ((): string => {
    const source = read('src/llm/ForgeInstructionsLoader.ts');
    const start = source.indexOf('const STARTER_CONTENT = `');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('`;', start + 10));
  })();

  const descriptionSources: [string, string][] = toolFiles.map(
    (file) => [file, modelFacingText(read(file))] as [string, string],
  );
  const proseSources: [string, string][] = [
    ['src/llm/ForgeInstructionsLoader.ts', starterContent],
    ...fs
      .readdirSync(path.join(root, 'config/templates/builtin'))
      .filter((name) => name.endsWith('.njk'))
      .map(
        (name) =>
          [`config/templates/builtin/${name}`, read(`config/templates/builtin/${name}`)] as [
            string,
            string,
          ],
      ),
  ];

  const offendersFor = (sources: [string, string][], allow: Set<string>): string[] =>
    [
      ...new Set(
        sources.flatMap(([file, text]) =>
          Array.from(text.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g))
            .map((match) => match[1]!)
            .filter((name) => !registered.has(name) && !allow.has(name))
            .map((name) => `${file}: \`${name}\``),
        ),
      ),
    ].sort();

  it('names only registered tools in the text a model reads as current', () => {
    expect(offendersFor(descriptionSources, descriptionAllowlist)).toEqual([]);
  });

  it('names no replaced tool in the text a model reads as current', () => {
    // The audit's A-1: `find_references` stayed in a description a month after
    // the tool went away. A retired name is fine in prose that says it was
    // replaced; in a tool description the model reads it as current.
    expect(
      [
        ...new Set(
          descriptionSources.flatMap(([file, text]) =>
            Array.from(text.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g))
              .map((match) => match[1]!)
              .filter((name) => retiredNames.has(name))
              .map((name) => `${file}: \`${name}\``),
          ),
        ),
      ].sort(),
    ).toEqual([]);
  });

  it('lets the starter file and the prompt templates name a replaced tool', () => {
    expect(offendersFor(proseSources, proseAllowlist)).toEqual([]);
  });

  it('has a registry to compare against', () => {
    // Guards the scanner itself: a broken walk would make the check pass by
    // collecting no names at all.
    expect(registered.size).toBeGreaterThan(80);
    expect(registered.has('shell')).toBe(true);
    expect(registered.has('edit_file')).toBe(true);
  });
});

// ── 4. forge.* keys named in active docs ──────────────────────────────────────

describe('forge.* names in the active docs', () => {
  const activeDocs = [
    'README.md',
    'AI_SETUP.md',
    'ROADMAP.md',
    'docs/COMMANDS.md',
    'docs/DELEGATION.md',
    'docs/JOBS.md',
    'docs/REMOTE_CONTROL.md',
    'docs/REMOTE_CONTROL_VALIDATION.md',
    'docs/TELEGRAM_QUICKSTART.md',
    'docs/SHARED_RUNTIME.md',
    'docs/BROWSER_DESKTOP_TOOLS.md',
    'docs/LOCAL_MODEL_OPTIMIZATIONS.md',
    'docs/LLAMACPP_INSTALL.md',
    'docs/LLAMACPP_UPDATE.md',
    'docs/AGENT_TOOL_TRAPS.md',
    'docs/OWNERS.md',
    'docs/TOOL_COVERAGE.md',
  ];

  const known = new Set<string>([
    ...Object.keys(pkg.contributes.configuration.properties),
    ...pkg.contributes.commands.map((command) => command.command),
    // `forge.sh` is the agent-bus script under ~/.forge/agent-bus, not a key.
    'forge.sh',
  ]);

  it('names only settings and commands the manifest carries', () => {
    const offenders = activeDocs
      .filter((file) => fs.existsSync(path.join(root, file)))
      .flatMap((file) =>
        Array.from(read(file).matchAll(/forge\.[A-Za-z][A-Za-z0-9.]+/g))
          .map((match) => match[0])
          // `forge.remote.<channel>.ownerId` names a pattern, not one key.
          .filter((token) => !token.endsWith('.'))
          .filter((token) => !known.has(token))
          .map((token) => `${file}: ${token}`),
      );
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('has settings to compare against', () => {
    expect(Object.keys(pkg.contributes.configuration.properties).length).toBeGreaterThan(10);
  });
});

// ── 5. the remote command list the two guides print ───────────────────────────

describe('remote command inventory', () => {
  /**
   * `src/remote/remoteHelpText.ts` is the single source for Telegram's section
   * menu and the plain help text, so it is also the source the two guides have
   * to agree with. The store page left thirteen commands out for a release
   * (`/agents` `/answer` `/claude` `/codex` `/copilot` `/tell` `/speed`
   * `/chatmode` `/contacts` `/contact` `/send` `/jobs` `/job`) and
   * `docs/REMOTE_CONTROL.md` left out the same set plus `/unloadall`; nothing
   * checked either page, so this is the check the audit's phase 3 left as the
   * last unguarded claim.
   */
  const canonical = new Set(
    Array.from(
      read('src/remote/remoteHelpText.ts').matchAll(/usage: '\/([a-z][a-z0-9]*)/g),
      (match) => match[1]!,
    ),
  );

  /**
   * Words the handler still parses but the help text no longer teaches, so a
   * guide may name them without them being commands: `RemoteCommandHandler.ts`
   * :250 keeps `/new <n>` as a silent workspace switch, :272-277 keeps `/list`
   * for `/chats`, `/select` for `/chat` and `/models` for `/model`, and
   * `/commands` for `/help`. `/new` and `/workspace` are already canonical, so
   * only the four below are extra.
   */
  const silentAliases = new Set(['commands', 'list', 'select', 'models']);

  const paragraph = (file: string, start: string, end: string): string => {
    const doc = read(file);
    const from = doc.indexOf(start);
    const stop = doc.indexOf(end, from + start.length);
    expect(from).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(from);
    return doc.slice(from, stop);
  };

  const listed = (text: string): Set<string> =>
    new Set(
      Array.from(
        // A command word, not a path segment: `src/remote/remoteHelpText.ts`
        // sits in the same paragraph, so a slash after a word character or a
        // dot is not a command, and `remoteHelpText` is not `remote`.
        text.matchAll(/(?<![\w.])\/([a-z][a-z0-9]+)\b/g),
        (match) => match[1]!,
      ),
    );

  const phonePage = listed(paragraph('README.md', '**Commands.**', '\n\n**`/sleep`'));
  const remoteDoc = listed(
    paragraph(
      'docs/REMOTE_CONTROL.md',
      'Remote commands come from one source',
      'Telegram publishes the main commands',
    ),
  );

  it('has a real inventory to compare against', () => {
    expect(canonical.size).toBeGreaterThan(30);
    expect(canonical.has('help')).toBe(true);
    expect(canonical.has('answer')).toBe(true);
  });

  it('the store page lists every command the help text defines', () => {
    expect([...canonical].filter((command) => !phonePage.has(command)).sort()).toEqual([]);
  });

  it('the remote guide lists every command the help text defines', () => {
    expect([...canonical].filter((command) => !remoteDoc.has(command)).sort()).toEqual([]);
  });

  it('neither page teaches a command the handler does not have', () => {
    const extra = (page: Set<string>): string[] =>
      [...page].filter((command) => !canonical.has(command) && !silentAliases.has(command)).sort();
    expect(extra(phonePage)).toEqual([]);
    expect(extra(remoteDoc)).toEqual([]);
  });
});

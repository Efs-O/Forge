import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyOwnerOnlyWriteGuard,
  ownerOnlySetFor,
  ownerOnlyWriteTargetFor,
  type OwnerOnlySet,
} from '../../src/tools/ownerPaths';
import { makeReadFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import {
  makeInsertCodeTool,
  makeReplaceSelectionTool,
} from '../../src/tools/builtinTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import {
  makeDeleteFileTool,
  makeFormatFileTool,
  makeMoveFileTool,
  makeRenameSymbolTool,
} from '../../src/tools/fileEditTools';
import { makeApplyCodeActionTool } from '../../src/tools/codeActionTools';
import { makeEditNotebookCellTool } from '../../src/tools/notebookTools';
import { makeRestoreFileTool } from '../../src/tools/gitTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { findConfigPath } from '../../src/config/ConfigLoader';
import { openForgeFileRoots } from '../../src/tools/ownerPathsOpen';

/** Windows deep-path delete, as `FileToolExecution.test.ts` needs it too. */
function extendedPath(targetPath: string): string {
  if (process.platform !== 'win32' || targetPath.startsWith('\\\\?\\')) return targetPath;
  if (targetPath.startsWith('\\\\')) return `\\\\?\\UNC\\${targetPath.slice(2)}`;
  return `\\\\?\\${targetPath}`;
}

/**
 * The file-tool half of Lane A (`docs/plans/OWNER_GUARDS_PLAN.md` item 4), run
 * through the tools as `registerAllTools.ts` wires them: wrapped, refused before
 * any card by `ToolRegistry.invalidArgs`, and refused again in the handler for a
 * caller that dispatches without that pre-check.
 *
 * `home` is a second temporary folder, not the tester's real home, so a write
 * onto `~/.forge/` is a write onto a file this test created. `extra_file_roots`
 * carries it, because `~/.forge/` sits outside the workspace exactly as it does
 * in production — and the owner rule, not the containment rule, has to be what
 * stops it.
 */
describe('Forge own configuration is refused by the file tools', () => {
  let workspace: string;
  let home: string;
  let globalStorage: string;
  let set: OwnerOnlySet;
  let extraRoots: () => readonly string[];
  const CONFIG_TEXT = 'active_model: none\n';
  const context = { beforeMutate: () => undefined } as never;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-ws-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-home-'));
    globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-gs-'));
    fs.mkdirSync(path.join(workspace, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.forge', 'config.yaml'), CONFIG_TEXT);
    fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.forge', 'note.txt'), 'owner notes\n');
    fs.writeFileSync(path.join(home, '.forge', 'config.yaml'), CONFIG_TEXT);
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(workspace) });
    set = ownerOnlySetFor({
      configPath: path.join(home, '.forge', 'config.yaml'),
      workspaceRoot: workspace,
      home,
    });
    extraRoots = () => [home];
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders?.splice(0);
    for (const dir of [workspace, home, globalStorage]) {
      fs.rmSync(extendedPath(dir), { recursive: true, force: true });
    }
  });

  const wrapped = <T extends { definition: { function: { name: string } } }>(tool: T) =>
    applyOwnerOnlyWriteGuard(tool, () => set);
  const writeFile = () => wrapped(makeWriteFileTool(extraRoots));
  const editFile = () => wrapped(makeEditFileTool(extraRoots));
  const lineEdits = () => wrapped(makeApplyLineEditsTool(extraRoots));
  const deleteFile = () => wrapped(makeDeleteFileTool(extraRoots));
  const moveFile = () => wrapped(makeMoveFileTool(extraRoots));

  it('refuses a write to .forge/config.yaml and leaves the file as it was', async () => {
    await expect(
      writeFile().handler(
        { path: '.forge/config.yaml', content: 'permissions:\n  fs:\n    delete: true\n' },
        context,
      ),
    ).rejects.toThrow(/owner/);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(CONFIG_TEXT);
  });

  it('refuses the same file however the call spells it', async () => {
    const tool = writeFile();
    for (const spelling of [
      '.forge/config.yaml',
      './.forge/config.yaml',
      '.FORGE\\Config.yaml',
      './x/../.forge/config.yaml',
      path.join(workspace, '.FORGE', 'CONFIG.YAML'),
    ]) {
      await expect(
        tool.handler({ path: spelling, content: 'x\n' }, context),
      ).rejects.toThrow(/owner only|only the owner/);
    }
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(CONFIG_TEXT);
  });

  it('refuses every other way a tool call can change it', async () => {
    await expect(
      editFile().handler({ path: '.forge/config.yaml', old_str: 'none', new_str: 'null' }, context),
    ).rejects.toThrow(/owner/);
    await expect(
      lineEdits().handler(
        {
          path: '.forge/config.yaml',
          operations: [
            {
              start_line: 1,
              end_line: 1,
              expected_lines: ['active_model: none'],
              replacement_lines: ['active_model: null'],
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      writeFile().handler({ path: path.join(home, '.forge', 'config.yaml'), content: 'x\n' }, context),
    ).rejects.toThrow(/owner/);
    await expect(deleteFile().handler({ path: '~/.forge/note.txt' }, context)).rejects.toThrow(
      /owner/,
    );
    await expect(
      moveFile().handler({ source: 'a.txt', destination: '.forge/config.yaml' }, context),
    ).rejects.toThrow(/owner/);
    await expect(
      moveFile().handler({ source: '~/.forge/note.txt', destination: 'note.txt' }, context),
    ).rejects.toThrow(/owner/);
    // `restore_file` is the sanctioned way back to a tracked version, and a
    // restore onto Forge's own config is a write like any other.
    await expect(
      wrapped(makeRestoreFileTool()).handler({ paths: ['.forge/config.yaml'] }, context),
    ).rejects.toThrow(/owner/);
  });

  it('refuses a batch the whole way: nothing a refused delete names is touched', async () => {
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'still here\n');
    await expect(
      deleteFile().handler({ paths: ['keep.txt', '~/.forge/note.txt'], to_trash: false }, context),
    ).rejects.toThrow(/owner/);
    expect(fs.existsSync(path.join(workspace, 'keep.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.forge', 'note.txt'), 'utf8')).toBe('owner notes\n');
  });

  it('keeps reads open, and a config.yaml outside .forge/ still writable', async () => {
    await expect(makeReadFileTool().handler({ path: '.forge/config.yaml' })).resolves.toContain(
      'active_model: none',
    );
    await writeFile().handler({ path: 'config.yaml', content: 'not the config\n' }, context);
    expect(fs.readFileSync(path.join(workspace, 'config.yaml'), 'utf8')).toBe('not the config\n');
    await writeFile().handler({ path: '.forge/config.yaml.bak', content: 'backup\n' }, context);
    expect(fs.existsSync(path.join(workspace, '.forge', 'config.yaml.bak'))).toBe(true);
    // Only the file Forge loads is guarded inside the workspace: `.forge/tmp/` is
    // where an agent puts its own scratch, and refusing the folder would break it.
    // `create_directory` is gone, so this writes a file inside it - which is also
    // how a folder gets made now: `write_file` creates the parents.
    await writeFile().handler({ path: '.forge/tmp/scratch.txt', content: 'scratch\n' }, context);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'tmp', 'scratch.txt'), 'utf8')).toBe(
      'scratch\n',
    );
  });

  it('refuses ~/.forge before the tool can report the path as outside the workspace', async () => {
    const target = path.join(home, '.forge', 'note.txt');
    // Without `extra_file_roots` this is the containment error the agent already
    // knows; with them the path is reachable, and the owner rule is what stops it.
    await expect(
      makeWriteFileTool(() => []).handler({ path: target, content: 'x\n' }, context),
    ).rejects.toThrow(/outside the workspace/);
    await expect(writeFile().handler({ path: target, content: 'x\n' }, context)).rejects.toThrow(
      /owner/,
    );
    expect(fs.readFileSync(path.join(home, '.forge', 'note.txt'), 'utf8')).toBe('owner notes\n');
  });

  it('allows memory and skill edits through the file tools without config roots', async () => {
    const memoryDir = path.join(home, '.forge', 'memories', 'proj');
    const skillDir = path.join(home, '.forge', 'skills', 'demo', 'scripts');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    const memory = path.join(memoryDir, 'x.md');
    const skill = path.join(skillDir, 'run.py');
    const builtInRoots = () => openForgeFileRoots(home);

    await wrapped(makeWriteFileTool(builtInRoots)).handler(
      { path: memory, content: 'memory\n' },
      context,
    );
    await wrapped(makeEditFileTool(builtInRoots)).handler(
      { path: memory, old_str: 'memory', new_str: 'updated memory' },
      context,
    );
    await wrapped(makeWriteFileTool(builtInRoots)).handler(
      { path: skill, content: 'print("skill")\n' },
      context,
    );

    expect(fs.readFileSync(memory, 'utf8')).toBe('updated memory\n');
    expect(fs.readFileSync(skill, 'utf8')).toBe('print("skill")\n');
  });

  it('keeps policy, jobs, and out-of-scope memory paths owner-only', async () => {
    const open = path.join(home, '.forge', 'memories', 'proj', 'x.md');
    const refused = [
      path.join(home, '.forge', 'policy.yaml'),
      path.join(home, '.forge', 'jobs', 'a.json'),
      path.join(home, '.forge', 'memories', 'proj', 'sub', 'x.md'),
      path.join(home, '.forge', 'memories', 'proj', 'x.txt'),
    ];
    expect(ownerOnlyWriteTargetFor(open, set)).toBeUndefined();
    const write = wrapped(makeWriteFileTool(() => openForgeFileRoots(home)));
    for (const target of refused) {
      expect(ownerOnlyWriteTargetFor(target, set)).toBeDefined();
      await expect(write.handler({ path: target, content: 'x\n' }, context)).rejects.toThrow(
        /owner/,
      );
    }
  });

  it('refuses before any card: ToolRegistry.invalidArgs, which ToolDispatch runs first', async () => {
    const registry = new ToolRegistry();
    const tool = writeFile();
    registry.register(tool);
    const args = { path: '.forge/config.yaml', content: 'x\n' };
    const refusal = registry.invalidArgs(tool, args);
    expect(refusal).toMatch(/^Error: write_file: \.forge\/config\.yaml is part of Forge/);
    expect(refusal).toMatch(/Tell the user what change you want and why/);
    // A call that is not owner-only still gets the schema checks it always had,
    // and a call missing `path` still gets the missing-argument error rather than
    // a guard that could not judge it.
    expect(registry.invalidArgs(tool, { path: 'notes.txt', content: 'x' })).toBeUndefined();
    expect(registry.invalidArgs(tool, { content: 'x' })).toMatch(/missing required `path`/);
    // The handler is the second entry point, for callers that dispatch without
    // the pre-check — `benchmark/toolHost.ts` calls `registry.dispatch` directly.
    await expect(
      registry.dispatch('write_file', args, new Set(['write']), context),
    ).rejects.toThrow(/owner/);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(CONFIG_TEXT);
  });

  it('refuses through every tool that can write, not only the four the plan names', () => {
    const registry = new ToolRegistry();
    const pathTools = [
      makeWriteFileTool(extraRoots),
      makeEditFileTool(extraRoots),
      makeApplyLineEditsTool(extraRoots),
      makeMoveFileTool(extraRoots),
      makeDeleteFileTool(extraRoots),
      makeFormatFileTool(extraRoots),
      makeRenameSymbolTool(extraRoots),
      makeApplyCodeActionTool(extraRoots),
      makeEditNotebookCellTool(),
      makeRestoreFileTool(),
    ].map((tool) => wrapped(tool));
    for (const tool of pathTools) registry.register(tool);
    // One argument object carries every field these schemas name; the guard runs
    // before the schema checks, so a tool missing its own required fields is
    // refused for the path, which is the earlier and more useful answer.
    const args = {
      path: '.forge/config.yaml',
      content: 'x\n',
      source: 'a.txt',
      destination: '.forge/config.yaml',
      paths: ['.forge/config.yaml'],
      line: 0,
      character: 0,
      title: 'x',
    };
    for (const tool of pathTools) {
      const refusal = registry.invalidArgs(tool, args);
      expect(refusal, `${tool.definition.function.name} must refuse its own path`).toMatch(
        /is part of Forge/,
      );
      expect(refusal, `${tool.definition.function.name} must tell the agent what to do`).toMatch(
        /Tell the user what change you want and why/,
      );
    }
    // The two active-editor tools are judged by the file the editor is on: with
    // the owner's config open, a write through the editor is refused too, and
    // with any other file open it is not.
    const editorTools = [makeReplaceSelectionTool(), makeInsertCodeTool()].map((tool) =>
      wrapped(tool),
    );
    for (const tool of editorTools) registry.register(tool);
    const editorOnConfig = {
      document: { uri: { fsPath: path.join(workspace, '.forge', 'config.yaml') } },
      selection: { isEmpty: true },
    };
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = editorOnConfig;
    for (const tool of editorTools) {
      const args =
        tool.definition.function.name === 'insert_code'
          ? { text: 'x', line: 0 }
          : { text: 'x' };
      expect(
        registry.invalidArgs(tool, args),
        `${tool.definition.function.name} must refuse the open config`,
      ).toMatch(/is part of Forge/);
    }
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: path.join(workspace, 'notes.txt') } },
      selection: { isEmpty: true },
    };
    for (const tool of editorTools) {
      const args =
        tool.definition.function.name === 'insert_code'
          ? { text: 'x', line: 0 }
          : { text: 'x' };
      expect(registry.invalidArgs(tool, args)).toBeUndefined();
    }
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
  });

  it('lets the agent edit its own workspace config once policy.yaml exists', async () => {
    // The acceptance criterion in `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §5:\n
    // an `edit_file` that changes a model's `num_ctx` in `.forge/config.yaml` is no\n
    // longer refused, because the keys that say what an agent may do now live in\n
    // `~/.forge/policy.yaml`, and `ConfigLoader` refuses any of them that come back.\n
    fs.writeFileSync(path.join(home, '.forge', 'policy.yaml'), '# the owner ran the migration\n');
    const rebuilt = () =>
      ownerOnlySetFor({
        configPath: path.join(home, '.forge', 'config.yaml'),
        workspaceRoot: workspace,
        home,
      });
    const tool = applyOwnerOnlyWriteGuard(makeEditFileTool(extraRoots), rebuilt);
    const edit = { path: '.forge/config.yaml', old_str: 'none', new_str: 'null' };
    expect(tool.refuseBeforeApproval?.(edit)).toBeUndefined();
    await tool.handler(edit, context);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(
      'active_model: null\n',
    );
    // The owner's file beside it is still refused, and still refused for the reason\n
    // the refusal text now gives: it is the file that says what an agent may do.\n
    await expect(
      tool.handler({ path: '~/.forge/policy.yaml', old_str: 'owner', new_str: 'agent' }, context),
    ).rejects.toThrow(/policy\.yaml/);
  });

  it('asks again on every decision, so deleting policy.yaml closes the file with no reload', async () => {
    // Claude's condition on the phase-3 gate: the guard must check whether the policy\n
    // file exists at each decision, not once at activation. A remembered "present"\n
    // would leave config.yaml open after the owner deleted the file that made opening\n
    // it safe. The set is rebuilt per call here exactly as `registerAllTools.ts`\n
    // wires it, and the SAME wrapped tool is called before and after it disappears.\n
    const policyPath = path.join(home, '.forge', 'policy.yaml');
    fs.writeFileSync(policyPath, '# the owner ran the migration\n');
    const rebuilt = () =>
      ownerOnlySetFor({
        configPath: path.join(home, '.forge', 'config.yaml'),
        workspaceRoot: workspace,
        home,
      });
    const tool = applyOwnerOnlyWriteGuard(makeWriteFileTool(extraRoots), rebuilt);
    const write = { path: '.forge/config.yaml', content: 'active_model: none\n' };
    expect(tool.refuseBeforeApproval?.(write)).toBeUndefined();
    fs.rmSync(policyPath);
    const refusal = tool.refuseBeforeApproval?.(write);
    expect(refusal).toMatch(/^Error: /);
    expect(refusal).toMatch(/owner only|only the owner/);
    expect(refusal).toContain('Move security settings to policy.yaml');
    await expect(tool.handler(write, context)).rejects.toThrow(/owner only|only the owner/);
    expect(fs.readFileSync(path.join(workspace, '.forge', 'config.yaml'), 'utf8')).toBe(CONFIG_TEXT);
  });

  it('agrees with ConfigLoader about which file is the config', () => {
    // The seam ownerPaths.ts's local `config.yaml` literal depends on: the path
    // `findConfigPath` picks for this workspace is the path the guard refuses.
    const found = findConfigPath(globalStorage, null);
    expect(found).toBe(path.join(workspace, '.forge', 'config.yaml'));
    const forThisWindow = ownerOnlySetFor({
      ...(found ? { configPath: found } : {}),
      workspaceRoot: workspace,
      home,
    });
    expect(ownerOnlyWriteTargetFor(found ?? '', forThisWindow)).toBeDefined();
    expect(ownerOnlyWriteTargetFor('.forge/config.yaml', forThisWindow)).toBeDefined();
    expect(ownerOnlyWriteTargetFor('.forge/other.yaml', forThisWindow)).toBeUndefined();
  });
});

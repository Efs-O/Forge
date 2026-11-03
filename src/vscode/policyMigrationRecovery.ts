/**
 * The one thing a window whose config would not load can still do about it.
 *
 * `bootstrapConfig` shows the reason and activation stops there: `extension.ts:87`
 * returns before `registerActivationCommands` at `:307`, so every command this
 * extension contributes — including the one the error message just told the owner
 * to run, `Forge: Move security settings to policy.yaml` — is sitting in the
 * palette with no handler. The message was then a dead end: the owner could not
 * run the command, and the only way out was to hand-edit the very YAML the
 * command exists to move for them. That is BL-026: the migration's own docstring
 * (`config/policyMigration.ts:41-44`) promises that a crash between its two
 * writes "is what a second run of this function finishes", and in a real window
 * that second run had no way to happen.
 *
 * Registering the command here makes the instruction actionable. It cannot apply
 * what it moved — this window has no loaded config to replace — so it runs the
 * migration, names the backup it wrote, and asks for a window reload, which is
 * the shortest path to a config that loads. Running it when the load failed for
 * another reason is harmless: the migration writes nothing when `config.yaml`
 * holds no policy key and reports that it found nothing to move.
 *
 * It is registered with the path `bootstrapConfig` actually tried, not a fresh
 * lookup: the window that failed must migrate the file it actually failed on,
 * and a second lookup could land on a different layer of the pair.
 *
 * The pair to keep in step: the healthy path registers this same id at
 * `nativeCommands.ts:234` through `registerActivationCommands`, which never runs
 * in a window that reaches this file — `extension.ts:87` returns first. If you
 * move one side earlier or later, check that they cannot both register.
 */
import * as vscode from 'vscode';
import { runPolicyMigration } from '../config/policyMigration';

export function registerPolicyMigrationRecovery(configPath: string): vscode.Disposable {
  return vscode.commands.registerCommand('forge.movePolicy', async () => {
    try {
      const result = runPolicyMigration(configPath);
      const moved =
        result.movedKeys.length > 0
          ? `moved ${result.movedKeys.length} policy key(s) into ${result.policyPath}`
          : `found no policy key in ${configPath} to move`;
      const untouched = result.policyWritten
        ? ''
        : '\npolicy.yaml already held exactly this content, so it was left untouched; ' +
          'the config side of the move is now finished.';
      const picked = await vscode.window.showInformationMessage(
        `Forge: ${moved}. Backup: ${result.backupPath}.${untouched}` +
          '\nThis window has no config loaded, so reload it to read the result.',
        'Reload now',
      );
      if (picked === 'Reload now')
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
      void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
    }
  });
}

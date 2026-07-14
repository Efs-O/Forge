import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { WorkerRunRequest, WorkerSpec } from '../workers/types';
import { classifyModelRoute, isCloudModelRoute } from '../llm/ModelRouteClassifier';

export function registerWorkerCommands(
  context: vscode.ExtensionContext,
  sidebar: SidebarProvider,
  getConfig: () => ForgeConfig,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.dispatchLocalWorkers', async () => {
      const countPick = await vscode.window.showQuickPick(['1', '2'], {
        title: 'Forge: Number of workers',
      });
      if (!countPick) return;
      const workers: WorkerSpec[] = [];
      for (let index = 0; index < Number(countPick); index++) {
        const config = getConfig();
        const cloudWorkersEnabled = config.permissions?.agents?.cloud_workers === true;
        const model = await vscode.window.showQuickPick(
          config.models
            .filter(
              (candidate) =>
                cloudWorkersEnabled || !isCloudModelRoute(classifyModelRoute(candidate)),
            )
            .map((candidate) => candidate.name),
          { title: `Worker ${index + 1}: model` },
        );
        if (!model) return;
        const task = await vscode.window.showInputBox({
          title: `Worker ${index + 1}: task`,
          prompt: 'Describe the independent coding task.',
        });
        if (!task) return;
        const accessPick = await vscode.window.showQuickPick(
          [
            { label: 'Read only', access: 'read' as const },
            { label: 'Write assigned files', access: 'write' as const },
          ],
          { title: `Worker ${index + 1}: access` },
        );
        if (!accessPick) return;
        const paths =
          accessPick.access === 'write'
            ? await vscode.window.showInputBox({
                title: `Worker ${index + 1}: exact writable paths`,
                prompt: 'Comma-separated workspace-relative files',
              })
            : undefined;
        if (accessPick.access === 'write' && !paths) return;
        const contextFiles = await vscode.window.showInputBox({
          title: `Worker ${index + 1}: optional starting files`,
          prompt: 'Comma-separated workspace-relative files (optional)',
        });
        workers.push({
          id: `worker-${index + 1}`,
          model,
          task,
          access: accessPick.access,
          ...(paths
            ? {
                allowed_paths: paths
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(contextFiles
            ? {
                context_files: contextFiles
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              }
            : {}),
        });
      }
      const reviewTask = await vscode.window.showInputBox({
        title: 'Coordinator review task (optional)',
      });
      const request: WorkerRunRequest = {
        workers,
        ...(reviewTask ? { review_task: reviewTask } : {}),
      };
      const summary = workers
        .map((worker) =>
          worker.access === 'write'
            ? `${worker.id}: ${worker.model} → ${worker.allowed_paths?.join(', ')}`
            : `${worker.id}: ${worker.model} → read only`,
        )
        .join('\n');
      const approved = await vscode.window.showWarningMessage(
        `Dispatch workers?\n${summary}`,
        { modal: true },
        'Dispatch',
      );
      if (approved !== 'Dispatch') return;
      try {
        await sidebar.dispatchWorkerRun(request);
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge workers: ${(err as Error).message}`);
      }
    }),
  );
}

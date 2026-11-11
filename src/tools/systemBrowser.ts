import { spawn, type ChildProcess } from 'child_process';

/** Start the system browser without routing navigation through VS Code's own prompt. */
export async function openSystemBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  const command =
    platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, { shell: false, detached: true, stdio: 'ignore' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`open_url_in_browser: could not start the system browser: ${message}`));
      return;
    }
    child.once('error', (error) => {
      reject(
        new Error(`open_url_in_browser: could not start the system browser: ${error.message}`),
      );
    });
    child.once('spawn', resolve);
    child.unref();
  });
}

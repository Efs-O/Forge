import * as vscode from 'vscode';
import { toDataURL } from 'qrcode';
import { updateConfigFile } from '../config/ConfigWriter';
import type { ForgeConfig } from '../config/types';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { TELEGRAM_BOT_TOKEN_SECRET } from '../remote/TelegramChannel';

export function registerRemoteCommands(
  context: vscode.ExtensionContext,
  runtime: RemoteRuntime,
  getConfig: () => ForgeConfig,
  configPath: string,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.remote.configure', async () => {
      const active = runtime.activeTransports();
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Set Telegram bot token', command: 'forge.remote.setTelegramToken' },
          { label: 'Validate remote control', command: 'forge.remote.validate' },
          { label: 'Pair Telegram owner', command: 'forge.remote.pairTelegram' },
          { label: 'Unpair Telegram owner', command: 'forge.remote.unpairTelegram' },
          { label: 'Set up Telegram authenticator', command: 'forge.remote.setupTelegramTotp' },
          { label: 'Reset Telegram authenticator', command: 'forge.remote.resetTelegramTotp' },
          { label: 'Disable Telegram authenticator', command: 'forge.remote.disableTelegramTotp' },
          { label: 'Link WhatsApp device', command: 'forge.remote.linkWhatsApp' },
          { label: 'Pair WhatsApp owner', command: 'forge.remote.pairWhatsApp' },
          { label: 'Unlink WhatsApp device', command: 'forge.remote.unlinkWhatsApp' },
          { label: 'Open Forge config', command: 'forge.openConfig' },
        ],
        {
          title: `Forge Remote Control — active: ${active.join(', ') || 'none'}`,
          placeHolder: 'Choose a setup action',
        },
      );
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
    vscode.commands.registerCommand('forge.remote.setTelegramToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Paste the Telegram bot token from BotFather',
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) return;
      await context.secrets.store(TELEGRAM_BOT_TOKEN_SECRET, token.trim());
      await runtime.applyConfig(getConfig());
      void vscode.window.showInformationMessage('Forge: Telegram bot token stored securely.');
    }),
    vscode.commands.registerCommand('forge.remote.validate', async () => {
      try {
        const status = await runtime.validationStatus(getConfig());
        const lines = [
          `Remote control: ${status.enabled ? 'enabled' : 'disabled'}`,
          ...status.transports.map(
            (item) =>
              `${item.name}: configured=${item.configured}, active=${item.active}, lease=${item.leaseOwned}, owner=${item.ownerPaired}, totp=${item.totpEnrolled}, provider=${item.providerOk} — ${item.detail}`,
          ),
          `Requests: queued=${status.requests.queued}, running=${status.requests.running}, crash-unknown=${status.requests.unknown}`,
          `Notifications: pending=${status.outbox.pending}, sending=${status.outbox.sending}, abandoned=${status.outbox.abandoned}`,
        ];
        void vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge remote validation failed: ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.remote.pairTelegram', () => {
      try {
        const code = runtime.beginPairing('telegram');
        void vscode.window.showInformationMessage(
          `Forge: send /pair ${code} to your bot in a private Telegram chat within 5 minutes.`,
          { modal: true },
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.unpairTelegram', async () => {
      await runtime.unpair('telegram');
      void vscode.window.showInformationMessage('Forge: Telegram remote owner unpaired.');
    }),
    vscode.commands.registerCommand('forge.remote.setupTelegramTotp', () =>
      enrollTotp(runtime, 'telegram', false),
    ),
    vscode.commands.registerCommand('forge.remote.resetTelegramTotp', () =>
      enrollTotp(runtime, 'telegram', true),
    ),
    vscode.commands.registerCommand('forge.remote.disableTelegramTotp', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Disable Telegram TOTP? The paired Telegram owner will regain access without an authenticator code.',
        { modal: true },
        'Disable TOTP',
      );
      if (confirm !== 'Disable TOTP') return;
      try {
        await runtime.disableTotp('telegram');
        void vscode.window.showInformationMessage('Forge: Telegram TOTP disabled locally.');
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge remote TOTP disable failed: ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.remote.setTimeout', async (value: unknown) => {
      const minutes = parseTimeout(value);
      if (minutes === undefined) {
        void vscode.window.showErrorMessage(
          'Forge remote timeout must be 0 or an integer from 1 to 1440.',
        );
        return;
      }
      try {
        updateConfigFile(configPath, (doc) => {
          doc.setIn(['remote', 'auth', 'inactivity_timeout_minutes'], minutes);
        });
        const current = getConfig();
        if (!current.remote) throw new Error('Forge remote configuration is unavailable.');
        await runtime.applyConfig({
          ...current,
          remote: {
            ...current.remote,
            auth: { ...current.remote.auth, inactivity_timeout_minutes: minutes },
          },
        });
        void vscode.window.showInformationMessage(
          `Forge: remote inactivity timeout ${minutes === 0 ? 'disabled' : `set to ${minutes} minutes`}.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Forge remote timeout update failed: ${(err as Error).message}`,
        );
      }
    }),
    vscode.commands.registerCommand('forge.remote.linkWhatsApp', async () => {
      const phone = await vscode.window.showInputBox({
        prompt: 'WhatsApp phone number, digits only, including country code',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          /^\d{7,15}$/.test(value) ? undefined : 'Enter 7-15 digits with country code.',
      });
      if (!phone) return;
      try {
        await runtime.requestWhatsAppPairingCode(phone);
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.pairWhatsApp', () => {
      try {
        const code = runtime.beginPairing('whatsapp');
        void vscode.window.showInformationMessage(
          `Forge: send /pair ${code} from your private WhatsApp chat within 5 minutes.`,
          { modal: true },
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
    vscode.commands.registerCommand('forge.remote.unlinkWhatsApp', async () => {
      try {
        await runtime.unlinkWhatsApp();
        await runtime.applyConfig(getConfig());
        void vscode.window.showInformationMessage(
          'Forge: WhatsApp device and remote owner were unlinked.',
        );
      } catch (err) {
        void vscode.window.showErrorMessage((err as Error).message);
      }
    }),
  );
}

async function enrollTotp(
  runtime: RemoteRuntime,
  channel: 'telegram' | 'whatsapp',
  reset: boolean,
): Promise<void> {
  try {
    const secret = await runtime.createTotpEnrollmentSecret(channel);
    const uri = `otpauth://totp/${encodeURIComponent(`Forge:${channel}`)}?secret=${secret}&issuer=Forge&digits=6&period=30`;
    const dataUrl = await toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
    const panel = vscode.window.createWebviewPanel(
      'forge.remote.totpEnrollment',
      `Forge ${channel} authenticator`,
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: false },
    );
    panel.webview.html = totpEnrollmentHtml(dataUrl, secret, channel);
    const code = await vscode.window.showInputBox({
      prompt: `Scan the QR code, then enter the current 6-digit ${channel} authenticator code`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (/^\d{6}$/.test(value) ? undefined : 'Enter exactly 6 digits.'),
    });
    if (!code) {
      panel.dispose();
      return;
    }
    await runtime.confirmTotpEnrollment(channel, secret, code);
    panel.dispose();
    void vscode.window.showInformationMessage(
      `Forge: ${channel} authenticator ${reset ? 'reset' : 'enrolled'} locally.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Forge remote TOTP enrollment failed: ${(err as Error).message}`,
    );
  }
}

function parseTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_440) {
    return undefined;
  }
  return value;
}

function totpEnrollmentHtml(dataUrl: string, secret: string, channel: string): string {
  return `<!doctype html>
<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
<style>body{font-family:var(--vscode-font-family);padding:20px}img{max-width:280px}code{word-break:break-all}</style></head>
<body><h2>Forge ${escapeHtml(channel)} authenticator</h2><p>Scan this locally with your authenticator app.</p>
<img src="${dataUrl}" alt="Forge authenticator QR code"><p>Manual key: <code>${escapeHtml(secret)}</code></p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character]!;
  });
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig, ImageGenerationConfig } from '../../src/config/types';
import type { SdServerBackend } from '../../src/backend/SdServerBackend';
import { UserNotificationService, FILE_DELIVERY_TURN_LIMIT } from '../../src/sidebar/UserNotificationService';
import { makeGenerateImageTool } from '../../src/tools/imageGeneration/generateImageTool';
import type { SdcppImageRequest } from '../../src/tools/imageGeneration/sdcppImageBackend';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ViewColumn: { Beside: -2 },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
  },
}));

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let root: string;

function cloudConfig(confirmEach: boolean): ImageGenerationConfig {
  return {
    backends: [
      {
        name: 'cloud',
        provider: 'xai',
        model: 'image-model',
        confirm_each: confirmEach,
      },
    ],
    default: 'cloud',
    output_dir: 'generated',
  } as ImageGenerationConfig;
}

const LOCAL_BACKEND = {
  name: 'local',
  provider: 'sdcpp',
  binary: 'C:/sd-server.exe',
  diffusion_model: 'C:/model.gguf',
  text_encoder: 'C:/encoder.gguf',
  vae: 'C:/vae.safetensors',
  cuda_device: 0,
  text_encoder_on_cpu: true,
  port: 8093,
  min_free_vram_mb: 7000,
  idle_timeout_ms: 600_000,
  request_timeout_ms: 300_000,
  defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
  extra_args: [],
  confirm_on_start: true,
  confirm_each: false,
} as const;

function localConfig(): ImageGenerationConfig {
  return {
    backends: [LOCAL_BACKEND],
    default: 'local',
    output_dir: 'generated',
  } as unknown as ImageGenerationConfig;
}

function context() {
  return { beforeMutate: vi.fn(), conversationId: 'conv-a' };
}

async function spendFileBudget(service: UserNotificationService): Promise<void> {
  for (let index = 0; index < FILE_DELIVERY_TURN_LIMIT; index += 1) {
    await service.deliverFile({
      conversationId: 'conv-a',
      text: 'prior file',
      imagePath: 'prior.png',
    });
  }
}

function cloudTool(
  service: UserNotificationService,
  config: ImageGenerationConfig,
) {
  return makeGenerateImageTool({
    getConfig: () => ({ image_generation: config }) as unknown as ForgeConfig,
    secrets: undefined,
    notifications: service,
    generate: vi.fn(async () => ({ bytes: IMAGE, mime: 'image/png' })),
    reveal: async () => undefined,
    now: () => new Date('2026-10-03T00:00:00Z'),
  });
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-image-budget-')));
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: root } },
  ];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('generate_image shared delivery budget', () => {
  it('uses the explicitly confirmed unbudgeted method only when confirm_each is true', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    await spendFileBudget(service);
    const unbudgeted = vi.spyOn(service, 'deliverImageUnbudgeted');
    const budgeted = vi.spyOn(service, 'deliverFile');
    const tool = cloudTool(service, cloudConfig(true));

    const result = await tool.handler({ prompt: 'fox' }, context());

    expect(result).toContain('Queued for 1 remote chat(s).');
    expect(unbudgeted).toHaveBeenCalledWith(
      'confirm_each',
      expect.objectContaining({ conversationId: 'conv-a' }),
    );
    expect(budgeted).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'generated', '20261003-000000-fox.png'))).toBe(true);
  });

  it('keeps a cloud image saved and reports budget refusal when confirm_each is false', async () => {
    const service = new UserNotificationService();
    await spendFileBudget(service);
    const unbudgeted = vi.spyOn(service, 'deliverImageUnbudgeted');
    const budgeted = vi.spyOn(service, 'deliverFile');
    const tool = cloudTool(service, cloudConfig(false));

    const result = await tool.handler({ prompt: 'cloud poster' }, context());
    const saved = path.join(root, 'generated', '20261003-000000-cloud-poster.png');

    expect(fs.readFileSync(saved)).toEqual(IMAGE);
    expect(result).toContain('Saved to generated/20261003-000000-cloud-poster.png, not sent');
    expect(result).toContain('per-turn file limit');
    expect(unbudgeted).not.toHaveBeenCalled();
    expect(budgeted).toHaveBeenCalledOnce();
  });

  it('budgets warm local backends even when no startup approval is needed', async () => {
    const service = new UserNotificationService();
    await spendFileBudget(service);
    const startApproval = vi.fn(() => undefined);
    const server = {
      startApproval,
      baseUrl: () => 'http://127.0.0.1:8093',
    } as unknown as SdServerBackend;
    const generateLocal = vi.fn(async (_request: SdcppImageRequest) => ({
      bytes: IMAGE,
      mime: 'image/png',
      seed: 7,
      width: 1024,
      height: 1024,
    }));
    const tool = makeGenerateImageTool({
      getConfig: () => ({ image_generation: localConfig() }) as unknown as ForgeConfig,
      secrets: undefined,
      notifications: service,
      sdServers: () => new Map([['local', server]]),
      generateLocal,
      reveal: async () => undefined,
      now: () => new Date('2026-10-03T00:00:00Z'),
    });
    const unbudgeted = vi.spyOn(service, 'deliverImageUnbudgeted');

    const result = await tool.handler({ prompt: 'local fox' }, context());
    const saved = path.join(root, 'generated', '20261003-000000-local-fox.png');

    expect(tool.approval?.({ prompt: 'local fox' })).toMatchObject({ dangerous: false });
    expect(startApproval).toHaveBeenCalledOnce();
    expect(generateLocal).toHaveBeenCalledOnce();
    expect(fs.readFileSync(saved)).toEqual(IMAGE);
    expect(result).toContain('Saved to generated/20261003-000000-local-fox.png, not sent');
    expect(unbudgeted).not.toHaveBeenCalled();
  });

  it('does not let cold-start approval exempt an unapproved local generation from the budget', async () => {
    const service = new UserNotificationService();
    await spendFileBudget(service);
    const server = {
      startApproval: () => ({ dangerous: true, detail: 'Start local backend' }),
      baseUrl: () => 'http://127.0.0.1:8093',
    } as unknown as SdServerBackend;
    const generateLocal = vi.fn(async () => ({
      bytes: IMAGE,
      mime: 'image/png',
      seed: 8,
      width: 1024,
      height: 1024,
    }));
    const tool = makeGenerateImageTool({
      getConfig: () => ({ image_generation: localConfig() }) as unknown as ForgeConfig,
      secrets: undefined,
      notifications: service,
      sdServers: () => new Map([['local', server]]),
      generateLocal,
      reveal: async () => undefined,
      now: () => new Date('2026-10-03T00:00:00Z'),
    });

    expect(tool.approval?.({ prompt: 'cold local' })).toMatchObject({ dangerous: true });
    const result = await tool.handler({ prompt: 'cold local' }, context());

    expect(generateLocal).toHaveBeenCalledOnce();
    expect(result).toContain('Saved to generated/20261003-000000-cold-local.png, not sent');
    expect(fs.existsSync(path.join(root, 'generated', '20261003-000000-cold-local.png'))).toBe(true);
  });
});

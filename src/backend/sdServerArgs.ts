import { createHash } from 'crypto';
import type { SdcppImageBackendConfig } from '../config/types';

export function composeSdServerArgs(config: SdcppImageBackendConfig): string[] {
  const args = [
    '--listen-ip',
    '127.0.0.1',
    '--listen-port',
    String(config.port),
    '--diffusion-model',
    config.diffusion_model,
    '--llm',
    config.text_encoder,
    '--vae',
    config.vae,
    '--backend',
    `te=${config.text_encoder_on_cpu ? 'cpu' : 'cuda0'},diffusion=cuda0,vae=cuda0`,
    '--auto-fit',
    config.auto_fit ? 'on' : 'off',
    // Absent means sd-server chooses its own budget (the pre-0.16 behaviour).
    // Passing it is a deliberate per-card tuning decision, so it is only ever
    // emitted when the owner configured one.
    ...(config.max_vram_gib ? ['--max-vram', String(config.max_vram_gib)] : []),
    ...(config.vision_encoder ? ['--llm_vision', config.vision_encoder] : []),
    '--fa',
    '--steps',
    String(config.defaults.steps),
    '--cfg-scale',
    String(config.defaults.cfg_scale),
    '--sampling-method',
    config.defaults.sampler,
    '-W',
    String(config.defaults.width),
    '-H',
    String(config.defaults.height),
  ];
  return [...args, ...config.extra_args];
}

/**
 * The loopback base URL every sd-server HTTP request is built from, so the
 * address is written down once: `SdServerBackend.baseUrl()` and the idle
 * module's orphan sweep both take it from here.
 */
export function sdServerBaseUrl(config: SdcppImageBackendConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export function sdServerSignature(config: SdcppImageBackendConfig): string {
  const identity = {
    binary: config.binary,
    diffusion_model: config.diffusion_model,
    text_encoder: config.text_encoder,
    vae: config.vae,
    port: config.port,
    cuda_device: config.cuda_device,
    args: composeSdServerArgs(config),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

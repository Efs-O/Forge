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
    'off',
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

import { describe, expect, it, vi } from 'vitest';
import {
  assertDevicesVramAvailable,
  type VramGateDevicesRequest,
} from '../../src/tools/imageGeneration/sdcppVramGate';

function gpu(index: number, memoryTotalMb = 16_000, memoryUsedMb = 4_000) {
  return {
    index,
    name: `test-gpu-${index}`,
    memoryTotalMb,
    memoryUsedMb,
    utilizationPercent: 0,
    temperatureC: 30,
  };
}

function request(probe: NonNullable<VramGateDevicesRequest['probe']>): VramGateDevicesRequest {
  return {
    label: 'generate_video: engine h3',
    configKey: 'media.video.engines[0]',
    deviceConfigKey: 'media.video.engines[0].cuda_devices',
    cudaDevices: [0, 1],
    minFreeVramMb: 11_000,
    modelPath: 'C:\\models\\h3.safetensors',
    alternatives: [],
    alternativeMessage: 'another GPU with enough free memory',
    nothingRan: 'no video was generated',
    holdersHint: 'another model or GPU process',
    probe,
  };
}

describe('the shared media VRAM gate', () => {
  it('refuses a render below the configured free-VRAM minimum', async () => {
    await expect(
      assertDevicesVramAvailable(request(async () => [gpu(0, 16_000, 5_001)])),
    ).rejects.toThrow(/only 10[.,]999 MB free.*11[.,]000 MB is required/);
  });

  it('refuses when the GPU probe fails', async () => {
    await expect(
      assertDevicesVramAvailable(
        request(async () => {
          throw new Error('nvidia-smi probe failed');
        }),
      ),
    ).rejects.toThrow(/could not check free VRAM.*nvidia-smi probe failed/);
  });

  it('allows above the minimum and checks every configured device', async () => {
    const probe = vi.fn(async () => [gpu(0, 16_000, 4_999), gpu(1, 16_000, 4_999)]);
    await expect(assertDevicesVramAvailable(request(probe))).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

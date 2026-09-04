import { describe, expect, it } from 'vitest';
import { parseNvidiaSmiCsv, parseWindowsProbe } from '../../src/system/systemProbes';
import {
  buildVramProcesses,
  collectSystemReport,
  mapLuidsToGpus,
  type GpuInfo,
} from '../../src/system/SystemReport';
import { formatSystemReport } from '../../src/system/formatSystemReport';
import { makeSystemStatusTool } from '../../src/tools/systemStatusTool';

/** Captured from this machine on 2026-09-04. */
const NVIDIA_SMI_CSV = [
  '0, NVIDIA GeForce RTX 3060, 0, 12288, 0, 42',
  '1, NVIDIA GeForce RTX 5060 Ti, 15868, 16311, 100, 67',
  '',
].join('\n');

const GB = 1024 * 1024 * 1024;

function gpu(overrides: Partial<GpuInfo> & { index: number }): GpuInfo {
  return {
    name: 'test',
    memoryUsedMb: 0,
    memoryTotalMb: 12288,
    utilizationPercent: 0,
    temperatureC: 40,
    ...overrides,
  };
}

describe('parseNvidiaSmiCsv', () => {
  it('parses the per-GPU query rows', () => {
    expect(parseNvidiaSmiCsv(NVIDIA_SMI_CSV)).toEqual([
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 3060',
        memoryUsedMb: 0,
        memoryTotalMb: 12288,
        utilizationPercent: 0,
        temperatureC: 42,
      },
      {
        index: 1,
        name: 'NVIDIA GeForce RTX 5060 Ti',
        memoryUsedMb: 15868,
        memoryTotalMb: 16311,
        utilizationPercent: 100,
        temperatureC: 67,
      },
    ]);
  });

  it('reads a driver [N/A] cell as unknown, never as zero', () => {
    const parsed = parseNvidiaSmiCsv('0, NVIDIA GeForce RTX 3060, [N/A], 12288, [N/A], 42');

    expect(parsed[0].memoryUsedMb).toBeNull();
    expect(parsed[0].utilizationPercent).toBeNull();
    expect(parsed[0].memoryTotalMb).toBe(12288);
  });
});

describe('parseWindowsProbe', () => {
  const payload = {
    gpuProcesses: [
      { pid: 20336, luid: '0x00000000_0x000134f8', bytes: 14.7 * GB },
      { pid: 17280, luid: '0x00000000_0x000134f8', bytes: 0.25 * GB },
    ],
    gpuAdapters: [
      { luid: '0x00000000_0x000134f8', bytes: 15.5 * GB },
      { luid: '0x00000000_0x0000abcd', bytes: 0 },
    ],
    processes: [
      { pid: 20336, name: 'python.exe' },
      { pid: 17280, name: 'Code.exe' },
    ],
    drives: [{ drive: 'C:', free: 88 * GB, size: 931 * GB }],
    gpuError: '',
  };

  it('reads the probe payload', () => {
    const probe = parseWindowsProbe(JSON.stringify(payload));

    expect(probe.vram).toHaveLength(2);
    expect(probe.processNames.get(20336)).toBe('python.exe');
    expect(probe.drives[0]).toEqual({ drive: 'C:', freeBytes: 88 * GB, totalBytes: 931 * GB });
    expect(probe.counterError).toBeNull();
  });

  it('normalises the single-element collections PowerShell 5.1 unwraps', () => {
    // ConvertTo-Json has no -AsArray there, so a one-element list serialises as
    // a bare object. Left unhandled this threw and lost the whole report.
    const probe = parseWindowsProbe(
      JSON.stringify({
        ...payload,
        gpuProcesses: payload.gpuProcesses[0],
        gpuAdapters: payload.gpuAdapters[0],
        processes: payload.processes[0],
        drives: payload.drives[0],
      }),
    );

    expect(probe.vram).toHaveLength(1);
    expect(probe.drives).toHaveLength(1);
  });

  it('carries a localised-counter failure out instead of reporting no consumers', () => {
    const probe = parseWindowsProbe(
      JSON.stringify({
        gpuProcesses: [],
        gpuAdapters: [],
        processes: [],
        drives: [],
        gpuError: 'The specified object was not found on the computer.',
      }),
    );

    expect(probe.counterError).toBe('The specified object was not found on the computer.');
  });
});

describe('mapLuidsToGpus', () => {
  const gpus = [gpu({ index: 0, memoryUsedMb: 0 }), gpu({ index: 1, memoryUsedMb: 15868 })];

  it('reconciles an adapter total against the nvidia-smi card it matches', () => {
    const map = mapLuidsToGpus([{ luid: 'luid-a', bytes: 15.5 * GB }], gpus);

    expect(map.get('luid-a')).toBe(1);
  });

  it('sums the phys_N instances that share one LUID', () => {
    const map = mapLuidsToGpus(
      [
        { luid: 'luid-a', bytes: 15 * GB },
        { luid: 'luid-a', bytes: 0.5 * GB },
      ],
      gpus,
    );

    expect(map.get('luid-a')).toBe(1);
  });

  it('refuses a card it cannot tell apart rather than guessing one', () => {
    const map = mapLuidsToGpus([{ luid: 'luid-a', bytes: 4 * GB }], [gpu({ index: 0 })]);

    expect(map.has('luid-a')).toBe(false);
  });

  it('never assigns two LUIDs to the same card', () => {
    const map = mapLuidsToGpus(
      [
        { luid: 'luid-a', bytes: 15.5 * GB },
        { luid: 'luid-b', bytes: 15.4 * GB },
      ],
      [gpu({ index: 1, memoryUsedMb: 15868 })],
    );

    expect([...map.values()]).toEqual([1]);
  });
});

describe('buildVramProcesses', () => {
  const probe = parseWindowsProbe(
    JSON.stringify({
      gpuProcesses: [
        { pid: 17280, luid: 'luid-a', bytes: 0.25 * GB },
        { pid: 20336, luid: 'luid-a', bytes: 14.7 * GB },
      ],
      gpuAdapters: [{ luid: 'luid-a', bytes: 15.5 * GB }],
      processes: [{ pid: 20336, name: 'llama-server.exe' }],
      drives: [],
      gpuError: '',
    }),
  );

  it('tags Forge-spawned backends, resolves the card, and sorts by size', () => {
    const processes = buildVramProcesses(probe, [gpu({ index: 1, memoryUsedMb: 15868 })], [
      { model: 'qwen38-27b', pid: 20336 },
    ]);

    expect(processes[0]).toEqual({
      pid: 20336,
      name: 'llama-server.exe',
      bytes: 14.7 * GB,
      gpuIndex: 1,
      forgeModel: 'qwen38-27b',
    });
    // Present in the counters, gone by the CIM query: reported, not dropped.
    expect(processes[1]).toMatchObject({ pid: 17280, name: null, forgeModel: null });
  });
});

describe('collectSystemReport', () => {
  const memory = () => ({ totalBytes: 64 * GB, freeBytes: 25.6 * GB });

  it('keeps the sections that answered when a probe fails', async () => {
    const report = await collectSystemReport({
      memory,
      gpuProbe: async () => {
        throw new Error('nvidia-smi is not on PATH');
      },
      windowsProbe: async () =>
        parseWindowsProbe(
          JSON.stringify({
            gpuProcesses: [],
            gpuAdapters: [],
            processes: [],
            drives: [{ drive: 'N:', free: 412 * GB, size: 1863 * GB }],
            gpuError: '',
          }),
        ),
    });

    expect(report.gpuError).toBe('nvidia-smi is not on PATH');
    expect(report.drives).toHaveLength(1);
    expect(report.ram.totalBytes).toBe(64 * GB);
  });
});

describe('formatSystemReport', () => {
  const base = {
    collectedAt: 0,
    gpus: [
      gpu({ index: 0, name: 'NVIDIA GeForce RTX 3060', memoryUsedMb: 0, temperatureC: 42 }),
      gpu({
        index: 1,
        name: 'NVIDIA GeForce RTX 5060 Ti',
        memoryUsedMb: 15868,
        memoryTotalMb: 16311,
        utilizationPercent: 100,
        temperatureC: 67,
      }),
    ],
    gpuError: null,
    vramProcesses: [
      {
        pid: 20336,
        name: 'llama-server.exe',
        bytes: 14.7 * GB,
        gpuIndex: 1,
        forgeModel: 'qwen38-27b',
      },
    ],
    vramProcessError: null,
    ram: { totalBytes: 64 * GB, freeBytes: 25.6 * GB },
    drives: [{ drive: 'N:', freeBytes: 412 * GB, totalBytes: 1863 * GB }],
    minVramBytes: 150 * 1024 * 1024,
  };

  it('nests each process under its card and names the Forge backend', () => {
    const text = formatSystemReport(base);

    expect(text).toContain('GPU 1  RTX 5060 Ti');
    expect(text).toContain('20336');
    expect(text).toContain('(Forge backend: qwen38-27b)');
    expect(text).toContain('RAM');
    expect(text).toContain('N:');
  });

  it('lists a process whose card could not be resolved rather than hiding it', () => {
    const text = formatSystemReport({
      ...base,
      vramProcesses: [{ ...base.vramProcesses[0], gpuIndex: null }],
    });

    expect(text).toContain('VRAM (card not resolved)');
    expect(text).toContain('20336');
  });

  it('states why a section is empty instead of showing nothing', () => {
    const text = formatSystemReport({
      ...base,
      gpus: [],
      gpuError: 'nvidia-smi is not on PATH',
      vramProcesses: [],
      vramProcessError: 'The specified object was not found on the computer.',
    });

    expect(text).toContain('nvidia-smi is not on PATH');
    expect(text).toContain('Per-process VRAM unavailable');
  });
});

describe('get_system_status', () => {
  const tool = makeSystemStatusTool({
    memory: () => ({ totalBytes: 64 * GB, freeBytes: 25.6 * GB }),
    backendProcesses: () => [{ model: 'qwen38-27b', pid: 20336 }],
    gpuProbe: async () => parseNvidiaSmiCsv(NVIDIA_SMI_CSV),
    windowsProbe: async () =>
      parseWindowsProbe(
        JSON.stringify({
          gpuProcesses: [{ pid: 20336, luid: 'luid-a', bytes: 14.7 * GB }],
          gpuAdapters: [{ luid: 'luid-a', bytes: 15.5 * GB }],
          processes: [{ pid: 20336, name: 'llama-server.exe' }],
          drives: [{ drive: 'N:', free: 412 * GB, size: 1863 * GB }],
          gpuError: '',
        }),
      ),
  });

  it('takes no free-form arguments', () => {
    expect(tool.definition.function.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
    // Read-only counters, so it runs without the per-call confirmation gate.
    expect(tool.autoApprove).toBe(true);
    expect(tool.permission).toBe('headless');
  });

  it('answers with the machine report, Forge backend named', async () => {
    const text = await tool.handler({});

    expect(text).toContain('GPU 1  RTX 5060 Ti');
    expect(text).toContain('20336  llama-server.exe');
    expect(text).toContain('(Forge backend: qwen38-27b)');
    expect(text).toContain('N:');
  });
});

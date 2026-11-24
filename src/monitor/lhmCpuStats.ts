/**
 * CPU package temperature and power from LibreHardwareMonitor's local JSON web
 * server (`http://127.0.0.1:8085/data.json`, Options → Remote Web Server).
 *
 * Ported from Strata's `_LhmCpu` (`serve/telemetry.py`, branch
 * `monitor/cards-gpu-selector`): the first CPU's sensors are matched by
 * `SensorId` and then picked by display name, because LibreHardwareMonitor
 * numbers them per CPU model (the package temperature is
 * `/intelcpu/0/temperature/10` on an i9-9900KF and another index elsewhere)
 * while naming them the same way. Values arrive as strings such as
 * `"62.0 °C"` and `"45,3 W"`, so the leading number is parsed out of each.
 */

import type { CpuStats } from './monitorTypes';

const CPU_SENSOR = /^\/(?:intel|amd)cpu\/0\/(temperature|power)\/\d+$/;
type CpuKind = 'temperature' | 'power';
const NAMES: Record<CpuKind, readonly string[]> = {
  temperature: [
    'CPU Package',
    'Package',
    'Core (Tctl/Tdie)',
    'Core (Tctl)',
    'Core (Tdie)',
    'Core Max',
  ],
  power: ['CPU Package', 'Package'],
};
const TIMEOUT_MS = 1500;

/** The leading number of a LibreHardwareMonitor value string (`"45,3 W"` → 45.3). */
function lhmNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Walk the sensor tree and pick the first named sensor of each kind that has a value. */
export function readLhmCpuTree(tree: unknown): CpuStats {
  const named: Record<CpuKind, Map<string, number | null>> = {
    temperature: new Map(),
    power: new Map(),
  };
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const sensorId = record.SensorId ? String(record.SensorId) : '';
    const match = CPU_SENSOR.exec(sensorId);
    if (match && typeof record.Text === 'string') {
      named[match[1] as CpuKind].set(record.Text.trim(), lhmNumber(record.Value));
    }
    if (Array.isArray(record.Children)) stack.push(...record.Children);
  }
  const pick = (kind: CpuKind): number | null => {
    for (const name of NAMES[kind]) {
      const value = named[kind].get(name);
      if (value !== undefined && value !== null) return value;
    }
    return null;
  };
  return { tempC: pick('temperature'), powerW: pick('power') };
}

/** One round trip to LibreHardwareMonitor: GET, parse, pick the package sensors. */
export async function readLhmCpuStats(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CpuStats> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw new Error(`LibreHardwareMonitor at ${url} answered ${response.status}`);
  }
  return readLhmCpuTree(await response.json());
}

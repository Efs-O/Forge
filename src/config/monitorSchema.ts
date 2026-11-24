import { z } from 'zod';

const loopbackHost = (spec: string): boolean => {
  const at = spec.lastIndexOf('@');
  if (at < 1) return true;
  const address = spec
    .slice(at + 1)
    .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
    .replace(/:\d+$/, '');
  return ['127.0.0.1', '::1', 'localhost'].includes(address.toLowerCase());
};

/** LibreHardwareMonitor runs on the machine Forge runs on; a URL for anywhere
 *  else would send the CPU readings (and the token-less endpoint) over a network. */
const loopbackUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())
  );
};

export const MonitorConfigSchema = z
  .object({
    ups: z
      .string()
      .regex(/^[^@\s]+@(?:\[[^\]]+\]|[^:\s]+)(?::\d+)?$/)
      .refine(loopbackHost, {
        message:
          'monitor.ups must point at this machine (127.0.0.1, ::1 or localhost); Forge does not reach other hosts for UPS readings.',
      })
      .optional(),
    cpu: z
      .string()
      .refine(loopbackUrl, {
        message:
          'monitor.cpu must point at this machine (127.0.0.1, ::1 or localhost); Forge does not reach other hosts for CPU readings.',
      })
      .optional(),
    /** Absent means true: the Monitor opens itself the first time a model server starts. */
    auto_open: z.boolean().optional(),
  })
  .strict()
  .optional();

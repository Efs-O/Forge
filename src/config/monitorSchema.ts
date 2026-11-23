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
  })
  .strict()
  .optional();

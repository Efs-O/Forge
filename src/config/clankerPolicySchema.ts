import { z } from 'zod';

/** Owner-only expiry for the default Clanker mode on newly created chats. */
export const ClankerPolicySchema = z
  .object({
    default_on_until: z.string().superRefine((value, ctx) => {
      const validShape =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
      const parsed = validShape ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid clanker.default_on_until value ${JSON.stringify(value)}; expected an ISO 8601 date-time`,
        });
        return;
      }
      const [date, time] = value.split('T');
      const [year, month, day] = date!.split('-').map(Number);
      const [hour, minute, second = '0'] = time!.split(/[Z+-]/, 1)[0]!.split(':');
      const numericSecond = Number(second.split('.')[0]);
      const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
      if (
        month! < 1 ||
        month! > 12 ||
        day! < 1 ||
        day! > days ||
        Number(hour) > 23 ||
        Number(minute) > 59 ||
        numericSecond > 59
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid clanker.default_on_until value ${JSON.stringify(value)}; expected a real ISO 8601 date-time`,
        });
      }
    }),
  })
  .strict()
  .optional();

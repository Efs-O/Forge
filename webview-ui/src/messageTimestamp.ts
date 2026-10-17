/** Render a local message time, adding a local date when it is not today. */
export function formatMessageTimestamp(
  createdAt: number | undefined,
  now: Date = new Date(),
): string | undefined {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return undefined;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return undefined;

  const timeParts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = timeParts.find((part) => part.type === 'hour')?.value;
  const minute = timeParts.find((part) => part.type === 'minute')?.value;
  if (!hour || !minute) return undefined;
  const time = `${hour}:${minute}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const day = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
  return `${day} · ${time}`;
}

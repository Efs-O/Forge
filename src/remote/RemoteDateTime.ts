/** Stable, locale-independent date/time used in remote command responses. */
export function formatRemoteDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** Phone-sized relative date in the window's local timezone. */
export function formatRemoteRelativeDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const current = new Date(now);
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor((now - timestamp) / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)} h ago`;
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const currentDay = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  ).getTime();
  const days = Math.floor((currentDay - dateDay) / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days >= 2 && days <= 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

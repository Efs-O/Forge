/** Stable, locale-independent date/time used in remote command responses. */
export function formatRemoteDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

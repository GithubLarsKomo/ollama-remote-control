const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value === 0) return '0 B';
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = scaled >= 100 || unit === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

export function formatTemperature(value: number): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  return `${value.toFixed(0)} °C`;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function displayValue(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : 'Unavailable';
}

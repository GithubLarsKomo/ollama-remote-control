import { describe, expect, it } from 'vitest';
import {
  displayValue,
  formatBytes,
  formatPercent,
  formatTemperature,
  formatTimestamp,
} from './format.js';

describe('dashboard formatters', () => {
  it('formats byte values without inventing precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GiB');
    expect(formatBytes(-1)).toBe('Unavailable');
  });

  it('bounds percentages and formats temperatures', () => {
    expect(formatPercent(55.4)).toBe('55%');
    expect(formatPercent(125)).toBe('100%');
    expect(formatTemperature(54.8)).toBe('55 °C');
  });

  it('falls back safely for empty and invalid values', () => {
    expect(displayValue('  value ')).toBe('value');
    expect(displayValue(' ')).toBe('Unavailable');
    expect(formatTimestamp('not-a-date')).toBe('Unavailable');
  });
});

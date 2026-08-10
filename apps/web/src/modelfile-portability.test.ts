import { describe, expect, it } from 'vitest';
import { modelfileExportFilename } from './modelfile-library.js';

describe('Modelfile export portability', () => {
  it('builds bounded path-safe filenames for historical revisions', () => {
    expect(modelfileExportFilename('R&D / Qwen: test \\ branch', 7)).toBe('R-D-Qwen-test-branch-r7.Modelfile');
    expect(modelfileExportFilename('../..\\evil\u0000name', 2)).toBe('evil-name-r2.Modelfile');
    const long = modelfileExportFilename('x'.repeat(200), 3);
    expect(long.endsWith('-r3.Modelfile')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(94);
    expect(/[\\/\u0000-\u001f\u007f]/u.test(long)).toBe(false);
  });

  it('does not reinterpret revision numbering into filesystem input', () => {
    expect(modelfileExportFilename('Model', 0)).toBe('Model-r1.Modelfile');
    expect(modelfileExportFilename('Model', Number.NaN)).toBe('Model-r1.Modelfile');
  });

  it('preserves CRLF/LF and opaque syntax because export operates on stored raw strings directly', () => {
    const raw = '# CRLF\r\nFROM hf.co/example/base:Q4_K_M\r\nX-FUTURE opaque\n';
    expect(new TextDecoder().decode(new TextEncoder().encode(raw))).toBe(raw);
  });
});

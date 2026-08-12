import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TargetStatusResult } from './api.js';
import ModelsPanel from './ModelsPanel.js';

const runningStatus = {
  target: {
    id: 'target-1',
  },
  container: {
    running: true,
  },
} as unknown as TargetStatusResult;

describe('ModelsPanel', () => {
  it('exposes separate Models and Modelfiles administration surfaces without rendering both at once', () => {
    const html = renderToStaticMarkup(
      <ModelsPanel
        disabled={false}
        onSignedOut={vi.fn()}
        status={runningStatus}
      />,
    );

    expect(html).toContain('aria-label="Model administration"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('>Models<');
    expect(html).toContain('>Modelfiles<');
    expect(html).toContain('Ollama API over pinned SSH');
    expect(html).not.toContain('First-class versioned artifacts');
    expect(html).not.toContain('Create or rebuild model from Modelfile revision');
  });
});
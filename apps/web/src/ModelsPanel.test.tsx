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
  it('exposes confirmed Modelfile create and replace/rebuild deployment from the production models surface', () => {
    const html = renderToStaticMarkup(
      <ModelsPanel
        disabled={false}
        onSignedOut={vi.fn()}
        status={runningStatus}
      />,
    );

    expect(html).toContain('Models');
    expect(html).toContain('Create or rebuild model from Modelfile revision');
    expect(html).toContain('Create fresh deploy plan');
    expect(html).toContain('Replace/rebuild an existing model with this exact name');
    expect(html).toContain('Confirmed immutable deployment');
  });
});

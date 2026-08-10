import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ModelSmokeTestPanel from './ModelSmokeTestPanel.js';
import type { ModelInventoryView } from './model-inventory.js';

const installed = {
  name: 'idle-model:latest',
  model: 'idle-model:latest',
  modifiedAt: '2026-08-10T03:00:00Z',
  sizeBytes: 4096,
  digest: 'a'.repeat(64),
  details: {
    format: 'gguf', family: 'fixture', families: ['fixture'],
    parameterSize: '1B', quantizationLevel: 'Q4',
  },
};

function inventory(loaded: boolean): ModelInventoryView {
  return {
    targetId: 'target-1',
    transport: { mode: 'published-binding' },
    installed: [installed],
    running: loaded ? [{
      ...installed,
      sizeBytes: 4096,
      expiresAt: '2026-08-10T04:00:00Z',
      sizeVramBytes: 2048,
      contextLength: 4096,
    }] : [],
  };
}

describe('ModelSmokeTestPanel', () => {
  it('offers the fixed smoke test only when an installed model is idle', () => {
    const html = renderToStaticMarkup(
      <ModelSmokeTestPanel
        disabled={false}
        inventory={inventory(false)}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
        targetName="Primary Ollama"
      />,
    );
    expect(html).toContain('Model smoke test');
    expect(html).toContain('idle-model:latest');
    expect(html).toContain('Smoke test selected model');
  });

  it('does not offer a smoke-test mutation for an already loaded model', () => {
    const html = renderToStaticMarkup(
      <ModelSmokeTestPanel
        disabled={false}
        inventory={inventory(true)}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
        targetName="Primary Ollama"
      />,
    );
    expect(html).toContain('No installed idle model');
    expect(html).not.toContain('Smoke test selected model');
  });
});

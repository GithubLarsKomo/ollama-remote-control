import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ModelUnloadControl from './ModelUnloadControl.js';
import type { RunningModelView } from './model-inventory.js';

const model = {
  name: 'hf.co/example/model:Q4_K_M',
  model: 'hf.co/example/model:Q4_K_M',
  sizeBytes: 4096,
  digest: 'd'.repeat(64),
  details: {
    format: 'gguf',
    family: 'fixture',
    families: ['fixture'],
    parameterSize: '1B',
    quantizationLevel: 'Q4',
  },
  expiresAt: '2026-08-10T03:00:00Z',
  sizeVramBytes: 2048,
  contextLength: 4096,
} satisfies RunningModelView;

describe('ModelUnloadControl', () => {
  it('exposes an explicit unload action only for a loaded model card', () => {
    const html = renderToStaticMarkup(
      <ModelUnloadControl
        disabled={false}
        model={model}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
        targetName="Primary Ollama"
      />,
    );
    expect(html).toContain('Unload');
    expect(html).toContain('model-unload-button');
  });

  it('honors the parent mutation-disabled state', () => {
    const html = renderToStaticMarkup(
      <ModelUnloadControl
        disabled
        model={model}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
        targetName="Primary Ollama"
      />,
    );
    expect(html).toContain('disabled=""');
  });
});

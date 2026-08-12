import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TargetCatalogEntry } from './api.js';
import UpdatePanel from './UpdatePanel.js';

const target = {
  id: 'target-1',
  displayName: 'Ollama target',
} as unknown as TargetCatalogEntry;

describe('UpdatePanel beta scope', () => {
  it('states that standalone update execution is unsupported in 0.1 beta', () => {
    const html = renderToStaticMarkup(
      <UpdatePanel
        onBusyChange={vi.fn()}
        onSignedOut={vi.fn()}
        onUpdated={vi.fn()}
        target={target}
      />,
    );

    expect(html).toContain('0.1 beta update boundary');
    expect(html).toContain('Standalone container updates are intentionally unsupported and fail closed in 0.1 beta');
    expect(html).toContain('Container update');
    expect(html).toContain('Manual rollback');
  });
});

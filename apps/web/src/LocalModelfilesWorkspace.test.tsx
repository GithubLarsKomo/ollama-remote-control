import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TargetStatusResult } from './api.js';
import type { ModelInventoryView } from './model-inventory.js';
import LocalModelfilesWorkspace from './LocalModelfilesWorkspace.js';

const status = { target: { id: 'target-1' } } as unknown as TargetStatusResult;
const inventory = { installed: [], running: [] } as unknown as ModelInventoryView;

describe('LocalModelfilesWorkspace', () => {
  it('exposes local file import next to the immutable Modelfile library', () => {
    const html = renderToStaticMarkup(
      <LocalModelfilesWorkspace disabled={false} inventory={inventory} onSignedOut={vi.fn()} status={status} />,
    );
    expect(html).toContain('Import raw Modelfile');
    expect(html).toContain('type="file"');
    expect(html).toContain('Local Modelfiles');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TargetStatusResult } from './api.js';
import type { ModelInventoryView } from './model-inventory.js';
import LocalModelfilesWorkspace from './LocalModelfilesWorkspace.js';

const status = { target: { id: 'target-1' } } as unknown as TargetStatusResult;
const inventory = { installed: [], running: [] } as unknown as ModelInventoryView;

describe('LocalModelfilesWorkspace', () => {
  it('exposes import, evidence-backed library state and the immutable editor from the Modelfiles surface', () => {
    const html = renderToStaticMarkup(
      <LocalModelfilesWorkspace disabled={false} inventory={inventory} onSignedOut={vi.fn()} status={status} />,
    );
    expect(html).toContain('Import raw Modelfile');
    expect(html).toContain('type="file"');
    expect(html).toContain('Modelfile library state');
    expect(html).toContain('Only persisted revision, validation and verified deployment evidence is shown');
    expect(html).toContain('Local Modelfiles');
  });
});

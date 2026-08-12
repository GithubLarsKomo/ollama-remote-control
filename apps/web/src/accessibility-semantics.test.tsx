import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TargetCatalogEntry, TargetStatusResult } from './api.js';
import AuditPanel from './AuditPanel.js';
import ModelsPanel from './ModelsPanel.js';

const runningStatus = {
  target: {
    id: 'target-1',
    selectedContainerId: 'ollama-container-id',
    displayName: 'Production Ollama',
  },
  container: {
    running: true,
  },
} as unknown as TargetStatusResult;

const targets = [{
  id: 'target-1',
  displayName: 'Production Ollama',
}] as unknown as readonly TargetCatalogEntry[];

describe('beta accessibility semantics', () => {
  it('renders model administration as a labelled keyboard-operable navigation surface', () => {
    const html = renderToStaticMarkup(
      <ModelsPanel disabled={false} onSignedOut={vi.fn()} status={runningStatus} />,
    );

    expect(html).toContain('<nav aria-label="Model administration"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-labelledby="models-title"');
    expect(html).toContain('<h2 id="models-title">Models</h2>');
    expect(html).toContain('type="button"');
  });

  it('renders audit filtering and pagination with labelled landmarks and live status semantics', () => {
    const html = renderToStaticMarkup(
      <AuditPanel onSignedOut={vi.fn()} targets={targets} />,
    );

    expect(html).toContain('aria-labelledby="audit-title"');
    expect(html).toContain('<h2 id="audit-title">Audit history</h2>');
    expect(html).toContain('role="status"');
    expect(html).toContain('audit-pagination');
    expect(html).toContain('>Previous</button>');
    expect(html).toContain('>Next</button>');
  });
});

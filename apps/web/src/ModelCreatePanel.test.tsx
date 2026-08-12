import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ModelCreatePanel from './ModelCreatePanel.js';

describe('ModelCreatePanel', () => {
  it('renders planning before confirmation and separates create from explicit replace/rebuild intent', () => {
    const html = renderToStaticMarkup(
      <ModelCreatePanel
        disabled={false}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
      />,
    );

    expect(html).toContain('Create or rebuild model from Modelfile revision');
    expect(html).toContain('Create fresh deploy plan');
    expect(html).toContain('Immutable revision');
    expect(html).toContain('Destination model');
    expect(html).toContain('Replace/rebuild an existing model with this exact name');
    expect(html).toContain('short-lived server-authoritative plan');
    expect(html).toContain('/api/show');
    expect(html).not.toContain('Confirm and create');
    expect(html).not.toContain('Confirm replace/rebuild');
    expect(html).not.toContain('confirmationToken');
    expect(html).not.toContain('SYSTEM');
    expect(html).not.toContain('secret');
  });
});

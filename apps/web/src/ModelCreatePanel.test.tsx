import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ModelCreatePanel from './ModelCreatePanel.js';

describe('ModelCreatePanel', () => {
  it('renders separate create-new and replace/rebuild planning before confirmation', () => {
    const html = renderToStaticMarkup(
      <ModelCreatePanel
        disabled={false}
        onSignedOut={vi.fn()}
        onSucceeded={vi.fn()}
        targetId="target-1"
      />,
    );

    expect(html).toContain('Create or replace model from Modelfile revision');
    expect(html).toContain('Plan create new model');
    expect(html).toContain('Plan replace/rebuild existing model');
    expect(html).toContain('Immutable revision');
    expect(html).toContain('Destination model');
    expect(html).toContain('exact installed destination digest');
    expect(html).not.toContain('Confirm replace/rebuild');
    expect(html).not.toContain('confirmationToken');
    expect(html).not.toContain('secret');
  });
});
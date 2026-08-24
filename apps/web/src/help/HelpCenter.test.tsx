import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HelpCenter from './HelpCenter.js';

describe('HelpCenter', () => {
  it('renders a globally available help launcher', () => {
    const html = renderToStaticMarkup(<HelpCenter />);
    expect(html).toContain('Open module help');
    expect(html).toContain('Help');
  });
});

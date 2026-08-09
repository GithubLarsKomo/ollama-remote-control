import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import StructuredModelfileEditor from './StructuredModelfileEditor.js';

describe('StructuredModelfileEditor', () => {
  it('renders known directives and preserves opaque-syntax warning without interpreting it', () => {
    const raw = [
      '# retained',
      'FROM llama3.2:latest',
      'PARAMETER temperature 0.7',
      'SYSTEM """You are useful."""',
      'X-FUTURE untouched',
      '',
    ].join('\n');
    const html = renderToStaticMarkup(
      <StructuredModelfileEditor disabled={false} onChange={vi.fn()} raw={raw} />,
    );

    expect(html).toContain('Locally parseable');
    expect(html).toContain('Opaque syntax preserved');
    expect(html).toContain('Unknown or opaque syntax is retained byte-for-byte');
    expect(html).toContain('FROM');
    expect(html).toContain('PARAMETER');
    expect(html).toContain('SYSTEM');
    expect(html).toContain('llama3.2:latest');
    expect(html).toContain('temperature');
    expect(html).toContain('0.7');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders bounded diagnostics for malformed drafts while keeping structured view available', () => {
    const html = renderToStaticMarkup(
      <StructuredModelfileEditor
        disabled={false}
        onChange={vi.fn()}
        raw={'PARAMETER num_ctx\nSYSTEM """open'}
      />,
    );

    expect(html).toContain('syntax errors');
    expect(html).toContain('FROM_REQUIRED');
    expect(html).toContain('PARAMETER_VALUE_REQUIRED');
    expect(html).toContain('UNCLOSED_MULTILINE');
    expect(html).toContain('L1:');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import StructuredModelfileEditor from './StructuredModelfileEditor.js';

describe('StructuredModelfileEditor', () => {
  it('renders current Ollama directives as first-class controls while preserving only future syntax as opaque', () => {
    const raw = [
      '# retained',
      'FROM llama3.2:latest',
      'DRAFT assistant:latest',
      'RENDERER qwen3.5',
      'PARSER qwen3.5',
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
    expect(html).toContain('DRAFT');
    expect(html).toContain('RENDERER');
    expect(html).toContain('PARSER');
    expect(html).toContain('PARAMETER');
    expect(html).toContain('SYSTEM');
    expect(html).toContain('assistant:latest');
    expect(html).toContain('qwen3.5');
    expect(html).toContain('temperature');
    expect(html).toContain('0.7');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('does not classify current DRAFT RENDERER or PARSER directives as opaque syntax', () => {
    const html = renderToStaticMarkup(
      <StructuredModelfileEditor
        disabled={false}
        onChange={vi.fn()}
        raw={'FROM base:latest\nDRAFT draft:latest\nRENDERER qwen3.5\nPARSER qwen3.5\n'}
      />,
    );

    expect(html).toContain('4 known directives');
    expect(html).not.toContain('Opaque syntax preserved');
    expect(html).toContain('draft:latest');
    expect(html).toContain('qwen3.5');
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

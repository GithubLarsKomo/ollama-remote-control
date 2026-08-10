import { describe, expect, it } from 'vitest';
import { safeModelSourceHref } from './ModelDetailsPanel.js';

describe('safeModelSourceHref', () => {
  it('accepts only canonical HTTPS Hugging Face repository links from resolved sources', () => {
    expect(safeModelSourceHref({
      reference: 'hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL',
      state: 'resolved',
      provider: 'huggingface',
      url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',
    })).toBe('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF');
  });

  it('does not make local, unresolved or manipulated API values clickable', () => {
    const rejected = [
      {
        reference: '/root/.ollama/models/blobs/sha256:deadbeef',
        state: 'local-artifact' as const,
        provider: null,
        url: null,
      },
      {
        reference: 'llama3.2:latest',
        state: 'unresolved' as const,
        provider: null,
        url: null,
      },
      {
        reference: 'hf.co/org/repo',
        state: 'resolved' as const,
        provider: 'huggingface' as const,
        url: 'https://huggingface.co.evil.example/org/repo',
      },
      {
        reference: 'hf.co/org/repo',
        state: 'resolved' as const,
        provider: 'huggingface' as const,
        url: 'https://huggingface.co/org/repo?download=1',
      },
      {
        reference: 'hf.co/org/repo',
        state: 'resolved' as const,
        provider: 'huggingface' as const,
        url: 'http://huggingface.co/org/repo',
      },
    ];

    for (const source of rejected) expect(safeModelSourceHref(source)).toBeNull();
  });
});

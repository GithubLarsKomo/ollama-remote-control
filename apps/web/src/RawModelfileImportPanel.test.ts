import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { defaultImportedModelfileName, readRawModelfile } from './RawModelfileImportPanel.js';

function file(bytes: Uint8Array, name = 'Example.Modelfile'): File {
  return new File([bytes], name, { type: 'text/plain' });
}

describe('raw Modelfile file import', () => {
  it('derives a safe editable display name without trusting path-like filename content', () => {
    expect(defaultImportedModelfileName('../../My Model.Modelfile')).toBe('My Model');
    expect(defaultImportedModelfileName('..\\..\\evil.txt')).toBe('evil');
    expect(defaultImportedModelfileName('\u0000\u0007.Modelfile')).toBe('Imported Modelfile');
  });

  it('decodes valid UTF-8 without normalizing CRLF or opaque syntax', async () => {
    const raw = '# keep\r\nFROM llama3.2:latest\r\nFUTURE opaque value\r\n';
    const bytes = new TextEncoder().encode(raw);
    await expect(readRawModelfile(file(bytes))).resolves.toBe(raw);
  });

  it('fails closed for empty, NUL, invalid UTF-8 and oversized files', async () => {
    await expect(readRawModelfile(file(new Uint8Array()))).rejects.toMatchObject({ code: 'INVALID_MODEFILE_FILE' } satisfies Partial<ApiError>);
    await expect(readRawModelfile(file(new TextEncoder().encode('FROM x\n\u0000')))).rejects.toMatchObject({ code: 'INVALID_MODEFILE_FILE' } satisfies Partial<ApiError>);
    await expect(readRawModelfile(file(new Uint8Array([0xc3, 0x28])))).rejects.toMatchObject({ code: 'INVALID_MODEFILE_ENCODING' } satisfies Partial<ApiError>);
    await expect(readRawModelfile(file(new Uint8Array(512 * 1024 + 1)))).rejects.toMatchObject({ code: 'INVALID_MODEFILE_FILE' } satisfies Partial<ApiError>);
  });
});

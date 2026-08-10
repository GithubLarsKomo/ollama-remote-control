const MAX_REFERENCE_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 96;
const MAX_VARIANT_LENGTH = 128;

export type ModelSourceResolutionState = 'resolved' | 'local-artifact' | 'unresolved';
export type ModelSourceProvider = 'huggingface';

export interface ModelSourceResolution {
  readonly reference: string;
  readonly state: ModelSourceResolutionState;
  readonly provider: ModelSourceProvider | null;
  readonly url: string | null;
}

function isLocalArtifact(reference: string): boolean {
  return (
    reference.startsWith('/')
    || reference.startsWith('./')
    || reference.startsWith('../')
    || reference.startsWith('~/')
    || /^[A-Za-z]:[\\/]/u.test(reference)
    || /^sha256:/iu.test(reference)
  );
}

function safeSegment(value: string): boolean {
  return (
    value.length >= 1
    && value.length <= MAX_SEGMENT_LENGTH
    && value !== '.'
    && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function huggingFaceUrl(reference: string): string | null {
  if (!reference.startsWith('hf.co/')) return null;
  if (/[?#%\\\u0000-\u0020\u007f]/u.test(reference)) return null;

  const match = /^hf\.co\/([^/:]+)\/([^/:]+)(?::([^/]+))?$/u.exec(reference);
  if (!match) return null;
  const [, owner, repository, variant] = match;
  if (!safeSegment(owner) || !safeSegment(repository)) return null;
  if (
    variant !== undefined
    && (
      variant.length < 1
      || variant.length > MAX_VARIANT_LENGTH
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(variant)
    )
  ) return null;

  return `https://huggingface.co/${owner}/${repository}`;
}

export function resolveModelSourceReference(value: string): ModelSourceResolution {
  const reference = typeof value === 'string' ? value.trim() : '';
  if (
    !reference
    || reference.length > MAX_REFERENCE_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(reference)
  ) {
    return { reference, state: 'unresolved', provider: null, url: null };
  }

  if (isLocalArtifact(reference)) {
    return { reference, state: 'local-artifact', provider: null, url: null };
  }

  const hfUrl = huggingFaceUrl(reference);
  if (hfUrl) {
    return { reference, state: 'resolved', provider: 'huggingface', url: hfUrl };
  }

  return { reference, state: 'unresolved', provider: null, url: null };
}

import { randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'orc-deploy-v1.';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export interface DeployConfirmationAuthority {
  readonly replaceExisting: boolean;
  readonly existingDestinationDigest: string | null;
  readonly existingDestinationSizeBytes: number | null;
}

export interface DestinationIdentity {
  readonly digest: string;
  readonly sizeBytes: number;
}

export type DestinationAuthorityCheck =
  | 'ok'
  | 'destination-exists'
  | 'replacement-target-missing'
  | 'replacement-target-stale';

interface TokenPayload {
  readonly r: boolean;
  readonly d: string | null;
  readonly s: number | null;
  readonly n: string;
}

function validAuthority(authority: DeployConfirmationAuthority): boolean {
  if (!authority.replaceExisting) {
    return authority.existingDestinationDigest === null && authority.existingDestinationSizeBytes === null;
  }
  return Boolean(
    authority.existingDestinationDigest
    && DIGEST_PATTERN.test(authority.existingDestinationDigest)
    && Number.isSafeInteger(authority.existingDestinationSizeBytes)
    && (authority.existingDestinationSizeBytes ?? -1) >= 0,
  );
}

export function createDeployConfirmationToken(authority: DeployConfirmationAuthority): string {
  if (!validAuthority(authority)) throw new Error('Deploy confirmation authority is invalid.');
  const payload: TokenPayload = {
    r: authority.replaceExisting,
    d: authority.existingDestinationDigest,
    s: authority.existingDestinationSizeBytes,
    n: randomBytes(32).toString('base64url'),
  };
  return `${TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function parseDeployConfirmationToken(token: string): DeployConfirmationAuthority | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const encoded = token.slice(TOKEN_PREFIX.length);
    if (!encoded || encoded.length > 768 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TokenPayload>;
    if (typeof parsed.r !== 'boolean' || typeof parsed.n !== 'string' || !NONCE_PATTERN.test(parsed.n)) return null;
    const authority: DeployConfirmationAuthority = {
      replaceExisting: parsed.r,
      existingDestinationDigest: parsed.d === null ? null : typeof parsed.d === 'string' ? parsed.d.toLowerCase() : null,
      existingDestinationSizeBytes: parsed.s === null ? null : typeof parsed.s === 'number' ? parsed.s : null,
    };
    return validAuthority(authority) ? authority : null;
  } catch {
    return null;
  }
}

export function checkDestinationAuthority(
  authority: DeployConfirmationAuthority,
  destination: DestinationIdentity | null,
): DestinationAuthorityCheck {
  if (!authority.replaceExisting) return destination ? 'destination-exists' : 'ok';
  if (!destination) return 'replacement-target-missing';
  return destination.digest === authority.existingDestinationDigest
    && destination.sizeBytes === authority.existingDestinationSizeBytes
    ? 'ok'
    : 'replacement-target-stale';
}

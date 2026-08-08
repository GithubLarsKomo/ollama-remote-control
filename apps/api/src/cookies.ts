export const SESSION_COOKIE = 'orc_session';
export const CSRF_COOKIE = 'orc_csrf';

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function baseCookie(name: string, value: string, maxAgeSeconds: number): string[] {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'Secure',
    'SameSite=Strict',
  ];
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [...baseCookie(SESSION_COOKIE, token, maxAgeSeconds), 'HttpOnly'].join('; ');
}

export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return baseCookie(CSRF_COOKIE, token, maxAgeSeconds).join('; ');
}

export function clearSessionCookies(): readonly string[] {
  return [
    sessionCookie('', 0),
    csrfCookie('', 0),
  ];
}

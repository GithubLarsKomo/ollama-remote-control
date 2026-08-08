import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as argon2 from 'argon2';
import type {
  AuthRepository,
  StoredSession,
  StoredUser,
  UserRole,
} from '@orc/core';

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
}

export interface CreatedSession {
  readonly user: PublicUser;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function publicUser(user: Pick<StoredUser, 'id' | 'username' | 'role'>): PublicUser {
  return { id: user.id, username: user.username, role: user.role };
}

function validateUsername(username: string): string {
  const normalized = username.trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/u.test(normalized)) {
    throw new AuthError(
      'INVALID_USERNAME',
      400,
      'Username must be 3-64 characters using letters, digits, dot, underscore or hyphen.',
    );
  }
  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(
      'INVALID_PASSWORD',
      400,
      'Password must contain between 12 and 1024 characters.',
    );
  }
}

function assertLoginInputBounded(username: string, password: string): void {
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError('INVALID_CREDENTIALS', 401, 'Invalid username or password.');
  }
}

function secureRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {}

  requiresBootstrap(): boolean {
    return this.repository.countUsers() === 0;
  }

  async bootstrapAdmin(username: string, password: string): Promise<PublicUser> {
    if (!this.requiresBootstrap()) {
      throw new AuthError('BOOTSTRAP_COMPLETE', 409, 'Administrator is already configured.');
    }

    const normalizedUsername = validateUsername(username);
    validatePassword(password);
    const user: StoredUser = {
      id: randomUUID(),
      username: normalizedUsername,
      passwordHash: await argon2.hash(password, ARGON2_OPTIONS),
      role: 'admin',
      createdAt: this.now().toISOString(),
    };

    if (!this.repository.createAdminIfNoneExists(user)) {
      throw new AuthError('BOOTSTRAP_COMPLETE', 409, 'Administrator is already configured.');
    }
    return publicUser(user);
  }

  async login(username: string, password: string): Promise<CreatedSession> {
    assertLoginInputBounded(username, password);
    const user = this.repository.findUserByUsername(username.trim());

    if (!user) {
      await argon2.hash('invalid-login-timing-equalizer', ARGON2_OPTIONS);
      throw new AuthError('INVALID_CREDENTIALS', 401, 'Invalid username or password.');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new AuthError('INVALID_CREDENTIALS', 401, 'Invalid username or password.');
    }

    const token = secureRandomToken();
    const csrfToken = secureRandomToken();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.sessionTtlMs);

    this.repository.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: digestToken(token),
      csrfTokenHash: digestToken(csrfToken),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return {
      user: publicUser(user),
      token,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  getSession(token: string | undefined): StoredSession | null {
    if (!token) return null;
    return this.repository.findActiveSessionByTokenHash(
      digestToken(token),
      this.now().toISOString(),
    );
  }

  assertCsrf(session: StoredSession, csrfToken: string | undefined): void {
    if (!csrfToken) {
      throw new AuthError('CSRF_REQUIRED', 403, 'CSRF token is required.');
    }
    const provided = Buffer.from(digestToken(csrfToken), 'utf8');
    const expected = Buffer.from(session.csrfTokenHash, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AuthError('CSRF_INVALID', 403, 'CSRF token is invalid.');
    }
  }

  logout(session: StoredSession): void {
    this.repository.revokeSession(session.id, this.now().toISOString());
  }
}

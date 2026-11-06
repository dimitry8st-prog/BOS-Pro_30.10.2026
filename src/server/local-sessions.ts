import { createHash, randomBytes } from 'node:crypto';

export type SessionIdentity = { userId: string; workspaceId: string };

export type LocalSessionOptions = {
  now?: () => number;
  maxSessions?: number;
};

type StoredSession = { identity: SessionIdentity; expiresAt: number };

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Process-local session registry for the educational server boundary.
 * issue() is trusted-server provisioning, never a public login operation.
 * Restarting the process invalidates every session; there is no public auth here.
 */
export class LocalSessions {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly clock: () => number;
  private readonly maxSessions: number;

  constructor(options: LocalSessionOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 1024;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new Error('invalid_session_capacity');
    }
  }

  issue(identity: SessionIdentity, ttlMs = DEFAULT_TTL_MS): string {
    if (!identity || typeof identity !== 'object'
      || typeof identity.userId !== 'string' || !ID.test(identity.userId)
      || typeof identity.workspaceId !== 'string' || !ID.test(identity.workspaceId)) {
      throw new Error('invalid_session_identity');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
      throw new Error('invalid_session_ttl');
    }
    const now = this.now();
    if (!Number.isSafeInteger(now + ttlMs)) throw new Error('invalid_session_expiry');
    this.removeExpired(now);
    if (this.sessions.size >= this.maxSessions) throw new Error('session_capacity_reached');

    let token: string;
    let hash: string;
    do {
      token = randomBytes(32).toString('base64url');
      hash = tokenHash(token);
    } while (this.sessions.has(hash));

    this.sessions.set(hash, {
      identity: { userId: identity.userId, workspaceId: identity.workspaceId },
      expiresAt: now + ttlMs,
    });
    return token;
  }

  resolve(token: unknown): SessionIdentity | null {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const hash = tokenHash(token);
    const session = this.sessions.get(hash);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(hash);
      return null;
    }
    return { userId: session.identity.userId, workspaceId: session.identity.workspaceId };
  }

  revoke(token: unknown): void {
    if (typeof token === 'string' && TOKEN.test(token)) this.sessions.delete(tokenHash(token));
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_session_clock');
    return now;
  }

  private removeExpired(now: number): void {
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash);
    }
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

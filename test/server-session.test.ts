import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalSessions, type SessionIdentity } from '../src/server/local-sessions.js';

const alice: SessionIdentity = { userId: 'alice', workspaceId: 'ws_educational' };

test('local sessions issue opaque independent tokens and copy trusted identity', () => {
  const sessions = new LocalSessions();
  const identity = { ...alice };
  const first = sessions.issue(identity);
  const second = sessions.issue(identity);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.notEqual(first, second);
  identity.userId = 'bob';
  identity.workspaceId = 'ws_other';
  assert.deepEqual(sessions.resolve(first), alice);
  const resolved = sessions.resolve(first);
  assert.ok(resolved);
  resolved.userId = 'bob';
  resolved.workspaceId = 'ws_other';
  assert.deepEqual(sessions.resolve(first), alice);
  assert.deepEqual(sessions.resolve(second), alice);
});

test('fabricated, malformed, expired and revoked tokens never resolve', () => {
  let now = 1_000;
  const sessions = new LocalSessions({ now: () => now });
  const token = sessions.issue(alice, 100);
  for (const invalid of [null, undefined, {}, 42, '', 'alice', token + 'x', 'a'.repeat(43)]) {
    assert.equal(sessions.resolve(invalid), null);
    sessions.revoke(invalid);
  }
  assert.deepEqual(sessions.resolve(token), alice);
  now = 1_099;
  assert.deepEqual(sessions.resolve(token), alice);
  now = 1_100;
  assert.equal(sessions.resolve(token), null);
  const revoked = sessions.issue(alice);
  const retained = sessions.issue(alice);
  sessions.revoke(revoked);
  sessions.revoke(revoked);
  assert.equal(sessions.resolve(revoked), null);
  assert.deepEqual(sessions.resolve(retained), alice);
  // A separate process-local registry has no session for an otherwise valid token.
  assert.equal(new LocalSessions().resolve(retained), null);
});

test('default lifetime is fifteen minutes and cannot exceed twenty-four hours', () => {
  let now = 0;
  const sessions = new LocalSessions({ now: () => now });
  const standard = sessions.issue(alice);
  const longest = sessions.issue(alice, 24 * 60 * 60 * 1_000);
  now = 15 * 60 * 1_000 - 1;
  assert.deepEqual(sessions.resolve(standard), alice);
  now += 1;
  assert.equal(sessions.resolve(standard), null);
  assert.deepEqual(sessions.resolve(longest), alice);
  now = 24 * 60 * 60 * 1_000;
  assert.equal(sessions.resolve(longest), null);
  for (const invalid of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001]) {
    assert.throws(() => sessions.issue(alice, invalid), /invalid_session_ttl/);
  }
});

test('capacity is bounded, preserves active sessions and reclaims expired or revoked entries', () => {
  let now = 0;
  const sessions = new LocalSessions({ now: () => now, maxSessions: 2 });
  const expiring = sessions.issue(alice, 1);
  const active = sessions.issue(alice, 100);
  assert.throws(() => sessions.issue(alice), /session_capacity_reached/);
  assert.deepEqual(sessions.resolve(active), alice);
  now = 1;
  const replacement = sessions.issue(alice);
  assert.equal(sessions.resolve(expiring), null);
  assert.deepEqual(sessions.resolve(replacement), alice);
  assert.throws(() => sessions.issue(alice), /session_capacity_reached/);
  sessions.revoke(active);
  assert.deepEqual(sessions.resolve(sessions.issue(alice)), alice);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new LocalSessions({ maxSessions: invalid }), /invalid_session_capacity/);
  }
});

test('trusted provisioning still rejects invalid identity and unsafe clock inputs', () => {
  const sessions = new LocalSessions();
  for (const invalid of ['', 'with space', 'a'.repeat(129), '../alice', '\n']) {
    assert.throws(() => sessions.issue({ userId: invalid, workspaceId: alice.workspaceId }), /invalid_session_identity/);
    assert.throws(() => sessions.issue({ userId: alice.userId, workspaceId: invalid }), /invalid_session_identity/);
  }
  assert.doesNotThrow(() => sessions.issue({ userId: 'a'.repeat(128), workspaceId: 'b'.repeat(128) }));
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    assert.throws(() => new LocalSessions({ now: () => invalid }).issue(alice), /invalid_session_clock/);
  }
  assert.throws(() => new LocalSessions({ now: () => Number.MAX_SAFE_INTEGER }).issue(alice), /invalid_session_expiry/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSessionId, sessionObjectKey, saveSession, readSession,
  deleteSession, purgeExpiredSessions
} from "../src/session-vault.js";

const key = "a5".repeat(32);
const otherKey = "9d".repeat(32);
const now = 1791450000000;
function makeBucket() {
  const data = new Map();
  return {
    data,
    async put(k, value) { data.set(k, value); },
    async get(k) { return data.has(k) ? { text: async () => data.get(k) } : null; },
    async delete(k) { data.delete(k); },
    async list({ prefix, cursor, limit = 500 }) {
      const names = [...data.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? names.findIndex(n => n === cursor) + 1 : 0;
      const page = names.slice(start, start + limit);
      return {
        objects: page.map(key => ({ key })),
        truncated: start + limit < names.length,
        cursor: page.length && start + limit < names.length ? page[page.length-1] : undefined
      };
    }
  };
}

test("unguessable session id and opaque R2 key", async () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  const keyA = await sessionObjectKey(a);
  assert.match(keyA, /^oauth-sessions\/v1\/[a-f0-9]{64}$/);
  assert.doesNotMatch(keyA, new RegExp(a));
  await assert.rejects(() => sessionObjectKey("../unsafe"));
});

test("sealed R2 object cannot reveal OAuth credentials in plaintext", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "PRIVATE_ACCESS_TOKEN", now + 3600_000, now);
  assert.equal(bucket.data.size, 1);
  const raw = [...bucket.data.values()][0];
  assert.doesNotMatch(raw, /PRIVATE_ACCESS_TOKEN|refresh_token|playerId/i);
  const result = await readSession(bucket, key, id, now + 10);
  assert.deepEqual(result, { accessToken: "PRIVATE_ACCESS_TOKEN", expiresAt: now + 3600_000 });
});

test("expiration prevents serving tokens and physically deletes object", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "SECRET", now + 1000, now);
  assert.equal(await readSession(bucket, key, id, now + 1000), null);
  assert.equal(bucket.data.size, 0);
});

test("explicit user revocation is idempotent", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "TOKEN", now + 60000, now);
  await deleteSession(bucket, id);
  await deleteSession(bucket, id);
  assert.equal(await readSession(bucket, key, id, now), null);
  assert.equal(bucket.data.size, 0);
});

test("invalid vault configuration and TTL fail closed", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await assert.rejects(() => saveSession(bucket, "", id, "TOKEN", now + 60000, now));
  await assert.rejects(() => saveSession(bucket, key, id, "TOKEN", now + 86400001, now));
  await assert.rejects(() => saveSession(bucket, key, id, "", now + 60000, now));
  await assert.rejects(() => saveSession(bucket, key, id, "TOKEN", now - 100, now));
  assert.equal(bucket.data.size, 0);
});

test("wrong encryption key cannot read tokens or delete arbitrary records", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "PRIVATE_TOKEN", now + 60000, now);
  assert.equal(await readSession(bucket, otherKey, id, now), null);
  assert.equal(bucket.data.size, 1);
  assert.equal((await purgeExpiredSessions(bucket, otherKey, now + 120000)).removed, 0);
  assert.equal(bucket.data.size, 1);
  assert.deepEqual(await readSession(bucket, key, id, now), {
    accessToken: "PRIVATE_TOKEN", expiresAt: now + 60000
  });
});

test("tampering with encrypted payload never exposes a token", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "PRIVATE_TOKEN", now + 60000, now);
  const objectKey = await sessionObjectKey(id);
  const envelope = JSON.parse(bucket.data.get(objectKey));
  envelope.ciphertext = "A" + envelope.ciphertext.slice(1);
  bucket.data.set(objectKey, JSON.stringify(envelope));
  assert.equal(await readSession(bucket, key, id, now), null);
});

test("scheduled cleanup purges expired encrypted sessions only", async () => {
  const bucket = makeBucket();
  const expired = generateSessionId(), live = generateSessionId();
  await saveSession(bucket, key, expired, "EXPIRED", now + 1000, now);
  await saveSession(bucket, key, live, "LIVE", now + 9000, now);
  const result = await purgeExpiredSessions(bucket, key, now + 1500);
  assert.deepEqual(result, { scanned: 2, removed: 1 });
  assert.equal(bucket.data.size, 1);
  assert.equal((await readSession(bucket, key, live, now + 1500)).accessToken, "LIVE");
});

test("purge aborts if secret missing, rather than deleting records", async () => {
  const bucket = makeBucket(), id = generateSessionId();
  await saveSession(bucket, key, id, "TOKEN", now + 5000, now);
  await assert.rejects(() => purgeExpiredSessions(bucket, "", now + 6000));
  assert.equal(bucket.data.size, 1);
});

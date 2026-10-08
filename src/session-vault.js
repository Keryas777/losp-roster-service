// Private encrypted R2 session vault (foundation ONLY, not wired to OAuth yet).
// Secrets, tokens, profiles and player IDs must never appear in object keys, logs,
// publicly accessible pages, customMetadata or source control.
const PREFIX = "oauth-sessions/v1/";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // Initial prototype; shorter than Scopely's 30-day limit.
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid ciphertext encoding");
  const plain = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(plain + "=".repeat((4 - plain.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeKeyHex(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Session encryption secret is not configured");
  }
  return Uint8Array.from(hex.match(/../g), segment => parseInt(segment, 16));
}

async function importKey(hex) {
  return crypto.subtle.importKey("raw", decodeKeyHex(hex), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function generateSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

export async function sessionObjectKey(id) {
  if (!ID_PATTERN.test(id || "")) throw new Error("Invalid session ID");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(id)));
  return PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateLifetime(value, now) {
  if (!Number.isSafeInteger(value) || value <= now || value > now + MAX_AGE_MS) {
    throw new Error("Session expiry is invalid");
  }
}

// Future OAuth integration will create exactly one record per browser session.
// Refresh is intentionally NOT implemented until single-use rotation and
// provider-side consent revocation are fully handled.
export async function saveSession(bucket, keyHex, id, accessToken, expiresAt, now = Date.now()) {
  if (!bucket?.put) throw new Error("R2 is not configured");
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16384) {
    throw new Error("Invalid access token");
  }
  validateLifetime(expiresAt, now);
  const objectKey = await sessionObjectKey(id);
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = ENC.encode(JSON.stringify({
    version: 1, createdAt: now, expiresAt, accessToken
  }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: ENC.encode(objectKey)
  }, key, payload));
  await bucket.put(objectKey, JSON.stringify({
    version: 1, iv: base64url(iv), ciphertext: base64url(ciphertext)
  }));
  return { expiresAt };
}

export async function deleteSession(bucket, id) {
  if (!bucket?.delete) throw new Error("R2 is not configured");
  const key = await sessionObjectKey(id);
  // Strongly consistent R2 deletion; no session index or stale cache.
  await bucket.delete(key);
}

export async function readSession(bucket, keyHex, id, now = Date.now()) {
  if (!bucket?.get || !bucket?.delete) throw new Error("R2 is not configured");
  const objectKey = await sessionObjectKey(id);
  const key = await importKey(keyHex);
  const stored = await bucket.get(objectKey);
  if (!stored) return null;
  try {
    const envelope = JSON.parse(await stored.text());
    if (envelope.version !== 1) throw new Error("Unknown version");
    const iv = fromBase64url(envelope.iv);
    if (iv.byteLength !== 12) throw new Error("Invalid IV");
    const ciphertext = fromBase64url(envelope.ciphertext);
    const plain = await crypto.subtle.decrypt({
      name: "AES-GCM", iv, additionalData: ENC.encode(objectKey)
    }, key, ciphertext);
    const record = JSON.parse(DEC.decode(plain));
    if (record.version !== 1 || typeof record.accessToken !== "string" ||
        !record.accessToken || !Number.isSafeInteger(record.createdAt) ||
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt <= record.createdAt ||
        record.expiresAt - record.createdAt > MAX_AGE_MS) {
      throw new Error("Invalid session record");
    }
    if (record.expiresAt <= now) {
      await bucket.delete(objectKey);
      return null;
    }
    return { accessToken: record.accessToken, expiresAt: record.expiresAt };
  } catch {
    // Fail closed if encrypted content is altered or damaged. Keep no raw logs.
    // Deleting avoids serving a damaged session on subsequent requests.
    await bucket.delete(objectKey);
    return null;
  }
}

// Operational safeguard for eventual scheduled cleanup. Cloudflare R2 lifecycle
// deletion is a backstop, not the sole enforcement of expiry.
export async function purgeExpiredSessions(bucket, keyHex, now = Date.now(), maxPages = 10) {
  if (!bucket?.list || !bucket?.get || !bucket?.delete) throw new Error("R2 is not configured");
  // Never purge with a missing or malformed encryption key.
  const key = await importKey(keyHex);
  let cursor;
  let removed = 0;
  let scanned = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await bucket.list({ prefix: PREFIX, limit: 500, ...(cursor ? { cursor } : {}) });
    for (const obj of listed.objects) {
      scanned++;
      // Do not derive cookie IDs from keys; cleanup directly uses the hash key.
      const stored = await bucket.get(obj.key);
      if (!stored) continue;
      let invalid = false;
      let expiresAt = 0;
      try {
        const envelope = JSON.parse(await stored.text());
        const iv = fromBase64url(envelope.iv);
        if (envelope.version !== 1 || iv.length !== 12) throw new Error("Bad version");
        const plaintext = await crypto.subtle.decrypt({
          name: "AES-GCM", iv, additionalData: ENC.encode(obj.key)
        }, key, fromBase64url(envelope.ciphertext));
        const row = JSON.parse(DEC.decode(plaintext));
        expiresAt = row.expiresAt;
        if (!Number.isSafeInteger(expiresAt) ||
            !Number.isSafeInteger(row.createdAt) ||
            expiresAt - row.createdAt > MAX_AGE_MS) invalid = true;
      } catch {
        invalid = true;
      }
      if (invalid || expiresAt <= now) {
        await bucket.delete(obj.key);
        removed++;
      }
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return { scanned, removed };
}

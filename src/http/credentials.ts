/**
 * How a presented secret is compared, whatever kind it is.
 *
 * Lived in app.ts while the API key was the only credential. The MCP routes
 * brought a second kind — a token in the path — and both have to be compared
 * the same way, so the comparison lives here once instead of being copied.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A secret as it is compared: a SHA-256 digest of it.
 *
 * Hashing both sides is what makes `timingSafeEqual` usable at all. It throws
 * on buffers of unequal length, so comparing raw secrets would turn a
 * wrong-length guess into an exception rather than a rejection, and the shape
 * of that failure would leak the length of the real one. Digests are always 32
 * bytes, so every comparison is the same comparison.
 */
export function digestOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Whether a presented secret matches any configured one. */
export function matches(presented: string, digests: readonly Buffer[]): boolean {
  const candidate = digestOf(presented);
  // Every configured secret is compared even after one matches: returning
  // early would let response time carry the position of the match in the list.
  let found = false;
  for (const digest of digests) {
    if (timingSafeEqual(candidate, digest)) found = true;
  }
  return found;
}

/**
 * A short, stable, non-reversible name for a secret, for rate-limit buckets
 * and caller ids. The digest, never the secret itself: these values live in
 * an in-memory store and appear in the log line written when a caller is
 * limited.
 */
export function bucketOf(secret: string): string {
  return digestOf(secret).toString('base64url').slice(0, 16);
}

/** The credential in an `Authorization: Bearer …` header, if there is one. */
export function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

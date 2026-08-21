import crypto from 'crypto';

/**
 * Constant-time string comparison for shared secrets (webhook secrets, tokens).
 *
 * A plain `a === b` short-circuits on the first differing byte, so the time it
 * takes leaks how many leading characters matched — a classic timing side
 * channel for guessing a secret one character at a time. `crypto.timingSafeEqual`
 * compares in time independent of where the difference is, BUT it throws when the
 * two buffers differ in length, so we guard length first (a length mismatch is an
 * immediate, safe `false` — the length of a secret is not itself sensitive).
 *
 * `provided` is typed `unknown` because it usually comes straight off
 * `req.query` (string | string[] | undefined); anything non-string is `false`.
 */
export function timingSafeEqualStr(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length guard: timingSafeEqual REQUIRES equal-length inputs (throws otherwise).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Opaque compound cursor for keyset (cursor) pagination.
 *
 * Why keyset and not offset: `skip`/`take` (page/limit) drifts and re-scans as
 * rows are inserted/deleted between requests — unacceptable for chat history and
 * ever-growing couple lists. A cursor over a TOTAL order (a sort key + the row
 * id as a deterministic tie-break) is stable under concurrent writes.
 *
 * The cursor carries `[key, id]`:
 *  - `key`  — the primary sort value as a string (an ISO timestamp for
 *             createdAt-ordered reads, or a `YYYY-MM-DD` rawDate).
 *  - `id`   — the row id, breaking ties when two rows share the same key.
 *
 * It is base64url-encoded so it survives a query string, and it is treated as
 * OPAQUE by clients: decode never throws — a malformed/garbage cursor returns
 * null and the caller falls back to the first page, so a bad value can never
 * 500 a list endpoint.
 */
export function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify([key, id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): { key: string; id: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { key: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clamp a client-supplied `limit` query param to a sane, bounded page size.
 * Non-numeric / missing → `fallback`; anything above `max` is capped (RULES §5
 * caps list limits at 100). Guarantees a positive integer.
 */
export function clampLimit(
  raw: unknown,
  fallback: number,
  max = 100,
): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

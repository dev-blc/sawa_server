import { encodeCursor, decodeCursor, clampLimit } from '../utils/cursor';

// Pure functions — no prisma, no mocks needed.

describe('cursor encode/decode', () => {
  it('round-trips key + id', () => {
    const c = encodeCursor('2026-08-20T10:00:00.000Z', 'abc123');
    expect(decodeCursor(c)).toEqual({ key: '2026-08-20T10:00:00.000Z', id: 'abc123' });
  });

  it('is url-safe (base64url) even for ids with +/= characters', () => {
    const c = encodeCursor('2026-08-20T10:00:00.000Z', 'id/with+odd=chars');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, or = to break a query string
    expect(decodeCursor(c)).toEqual({ key: '2026-08-20T10:00:00.000Z', id: 'id/with+odd=chars' });
  });

  it('returns null for garbage / empty / non-string (never throws)', () => {
    expect(decodeCursor('not-base64-@@@')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(123)).toBeNull();
    expect(decodeCursor(['a'])).toBeNull();
  });

  it('rejects a decoded payload that is not [string, string]', () => {
    const obj = Buffer.from(JSON.stringify({ key: 'x' }), 'utf8').toString('base64url');
    expect(decodeCursor(obj)).toBeNull();
    const nums = Buffer.from(JSON.stringify([1, 2]), 'utf8').toString('base64url');
    expect(decodeCursor(nums)).toBeNull();
  });
});

describe('clampLimit', () => {
  it('falls back when missing / non-numeric / non-positive', () => {
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit('abc', 50)).toBe(50);
    expect(clampLimit('0', 50)).toBe(50);
    expect(clampLimit('-5', 50)).toBe(50);
  });

  it('honors a valid limit and floors fractional values', () => {
    expect(clampLimit('20', 50)).toBe(20);
    expect(clampLimit('20.9', 50)).toBe(20);
  });

  it('caps at max (default 100, or an explicit cap)', () => {
    expect(clampLimit('9999', 50)).toBe(100);
    expect(clampLimit('9999', 50, 30)).toBe(30);
  });

  it('uses the first value when a query param is repeated (array)', () => {
    expect(clampLimit(['20'], 50)).toBe(20);
  });
});

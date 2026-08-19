import { timingSafeEqualStr } from '../utils/timingSafeEqual';

// Pure function — no prisma, no mocks needed.

describe('timingSafeEqualStr', () => {
  it('is true for identical strings', () => {
    expect(timingSafeEqualStr('super-secret-123', 'super-secret-123')).toBe(true);
  });

  it('is false for different same-length strings', () => {
    expect(timingSafeEqualStr('super-secret-123', 'super-secret-124')).toBe(false);
  });

  it('is false for different-length strings without throwing (length guard)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-secret')).toBe(false);
    expect(timingSafeEqualStr('a-much-longer-secret', 'short')).toBe(false);
  });

  it('is false for non-string provided values (req.query shapes)', () => {
    expect(timingSafeEqualStr(undefined, 'secret')).toBe(false);
    expect(timingSafeEqualStr(null, 'secret')).toBe(false);
    expect(timingSafeEqualStr(123, 'secret')).toBe(false);
    expect(timingSafeEqualStr(['secret'], 'secret')).toBe(false);
  });

  it('handles empty strings without throwing', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
    expect(timingSafeEqualStr('x', '')).toBe(false);
  });

  it('compares by BYTE length, so multibyte differences are caught', () => {
    // 'é' is 2 UTF-8 bytes; 'e' is 1 — the byte-length guard returns false.
    expect(timingSafeEqualStr('é', 'e')).toBe(false);
  });
});

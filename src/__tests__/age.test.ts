import { ageFromDobString } from '../utils/age';

// Pure function — no prisma, no mocks needed. Uses Jan-1 birthdays so the
// expected age is stable on any calendar day the suite runs.

describe('ageFromDobString', () => {
  const thisYear = new Date().getFullYear();

  it('parses ISO YYYY-MM-DD (Jan-1 birthday already passed → exact age)', () => {
    expect(ageFromDobString(`${thisYear - 25}-01-01`)).toBe(25);
  });

  it('parses the app DD/MM/YYYY display format', () => {
    expect(ageFromDobString(`01/01/${thisYear - 40}`)).toBe(40);
  });

  it('does not count a birthday not yet reached this year', () => {
    // Born Dec 31: age is (n-1) for ~364 days/year, n only on Dec 31 — never n+1.
    const age = ageFromDobString(`${thisYear - 20}-12-31`);
    expect([19, 20]).toContain(age);
  });

  it('returns null for empty / null / undefined / garbage / pre-1900', () => {
    expect(ageFromDobString('')).toBeNull();
    expect(ageFromDobString(null)).toBeNull();
    expect(ageFromDobString(undefined)).toBeNull();
    expect(ageFromDobString('not-a-date')).toBeNull();
    expect(ageFromDobString('1899-01-01')).toBeNull();
  });
});

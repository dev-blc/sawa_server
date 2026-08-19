/**
 * Age helpers shared across the couple controller (18+ onboarding gate) and the
 * couple service (public profile card shows AGE, never a raw DOB — a stranger's
 * full date of birth must not leak to another couple; see couple.service
 * getCoupleSummary). Kept in one place so the parsing rules can never drift
 * between the gate and the card (RULES §7 DRY).
 *
 * Parse a DOB string to age in years, or null if unparseable. Accepts the app's
 * DD/MM/YYYY display format and ISO (YYYY-MM-DD).
 */
export const ageFromDobString = (dob: string | null | undefined): number | null => {
  const s = String(dob ?? '').trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    y = +iso[1]; m = +iso[2]; d = +iso[3];
  } else {
    const parts = s.replace(/[^0-9]/g, '/').split('/').filter(Boolean);
    if (parts.length < 3) return null;
    d = +parts[0]; m = +parts[1]; y = +parts[2];
  }
  if (!d || !m || !y || y < 1900) return null;
  const birth = new Date(y, m - 1, d);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const md = now.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && now.getDate() < birth.getDate())) age--;
  return age;
};

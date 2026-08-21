/**
 * Deterministic couple-to-couple match scoring.
 *
 * Replaces the launch-era placeholder (`Math.random()*20+80` + two hardcoded
 * "insights" shown to every user) with an honest score computed from the data
 * couples actually give us:
 *
 *   • onboarding answers   (q1 life stage, q2 couple personality, q3 favorite
 *                           activities, q4 meeting pace — plus legacy q5/q6)
 *   • activities           (the "what you really enjoy" chips)
 *   • socialVibes          (legacy preference field, often empty)
 *   • matchCriteria        (q5-style labels or the AI-generated paragraph)
 *   • locationCity         (same-city bonus)
 *
 * Everything here is a pure function of its inputs — no I/O, no randomness —
 * so the same two couples always score the same. See scoreCouples() for the
 * weighting and the display floor rationale.
 */

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Display titles for q3 (favorite activities) onboarding option ids.
 * This is the feed's display-tag vocabulary — `getDiscoveryFeed` renders a
 * couple card's tags through this exact map, and insights reuse it so the
 * words a user reads in an insight match the tags on the card.
 */
export const Q3_TITLES: Record<string, string> = {
  'q3-dinners-home': 'Dinners at home',
  'q3-dinner': 'Dinner at home',
  'q3-restaurants': 'Exploring restaurants',
  'q3-outdoor': 'Outdoor activities',
  'q3-cultural': 'Cultural events',
  'q3-drinks': 'Casual drinks',
  'q3-trips': 'Weekend trips',
};

/**
 * Canonical labels for every onboarding option id the app has ever shipped
 * (mobile QuestionScreen ids + the legacy ids the AI-bio path maps). Answers
 * are stored as ids; legacy rows may hold titles directly — normalizeToken()
 * resolves both to the same comparable form.
 */
const OPTION_LABELS: Record<string, string> = {
  ...Q3_TITLES,
  // q1 — life stage
  'q1-career': 'Building careers',
  'q1-family': 'Family first',
  'q1-settled': 'Newly settled',
  'q1-living': 'Living it up',
  'q1-growing': 'Growing together',
  'q1-adventure': 'Always exploring',
  // q2 — couple personality ('q2-yes' ships in the app; 'q2-yes-couple' is legacy)
  'q2-hosts': 'The hosts',
  'q2-yes': "The 'yes' couple",
  'q2-yes-couple': "The 'yes' couple",
  'q2-planners': 'The planners',
  'q2-explorers': 'The explorers',
  // q4 — meeting pace
  'q4-once-month': 'Meeting once a month',
  'q4-twice-month': 'Meeting twice a month',
  'q4-once-week': 'Meeting once a week',
  'q4-when-fits': 'Meeting whenever it fits',
  // q5 — what makes a good match (legacy)
  'q5-similar-stage': 'Matches in a similar life stage',
  'q5-shared-interests': 'Shared interests',
  'q5-small-groups': 'Small group settings',
  'q5-structured-plans': 'Structured plans',
  'q5-clear-boundaries': 'Clear boundaries',
  'q5-weekend-availability': 'Weekend availability',
  // q6 — things to avoid (legacy)
  'q6-late-night': 'Avoiding late-night plans',
  'q6-large-groups': 'Avoiding very large groups',
  'q6-alcohol-centric': 'Avoiding alcohol-centric meetups',
  'q6-last-minute': 'Avoiding last-minute/spontaneous plans',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoringAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

/** The slice of a Couple row (+ its onboarding answers) the scorer reads. */
export interface ScoringCouple {
  locationCity?: string | null;
  activities?: string[] | null;
  socialVibes?: string[] | null;
  matchCriteria?: string[] | null;
  answers?: ScoringAnswer[] | null;
}

// ─── Score constants ──────────────────────────────────────────────────────────

/**
 * The warm minimum. Raw similarity is remapped onto [SCORE_FLOOR, 100] instead
 * of being hard-clamped: in a couples app, "12% match" reads as an insult, so
 * zero measured overlap displays as 55 while every real difference still
 * spreads monotonically across 55–100 (remapping preserves ordering, so feed
 * ranking is unaffected by the floor).
 */
export const SCORE_FLOOR = 55;

/**
 * Relative weights of each similarity dimension (sums to 90; the remaining 10
 * points are the same-city bonus). Dimensions where EITHER couple has no data
 * are excluded and the remaining weights are renormalized — absence of data is
 * not disagreement, so an unfilled legacy field never drags a score down.
 *
 *   answers       45 — richest structured signal (life stage, personality,
 *                      activities, meeting pace), present for complete profiles
 *   activities    25 — user-curated "what you really enjoy" chips
 *   socialVibes   10 — legacy field, frequently empty
 *   matchCriteria 10 — q5 labels or AI paragraph; noisy, weighted low
 */
const DIMENSION_WEIGHTS = {
  answers: 45,
  activities: 25,
  socialVibes: 10,
  matchCriteria: 10,
} as const;

const SIMILARITY_POINTS = 90;

/** Flat bonus when both couples share a (normalized) city. Additive, never
 * renormalized — two couples with nothing in common but a city stay near the
 * floor instead of reading as a perfect match. */
const CITY_BONUS_POINTS = 10;

// ─── Normalization helpers ────────────────────────────────────────────────────

/** Resolve an option id to its label (ids and stored titles converge), then
 * lowercase + collapse whitespace so vocabularies compare cleanly. */
const normalizeToken = (raw: string): string =>
  (OPTION_LABELS[raw] ?? raw).toLowerCase().replace(/\s+/g, ' ').trim();

const toTokenSet = (values?: string[] | null): Set<string> => {
  const set = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue;
    const token = normalizeToken(value);
    if (token.length > 0) set.add(token);
  }
  return set;
};

const intersect = (a: Set<string>, b: Set<string>): string[] => {
  const shared: string[] = [];
  for (const token of a) if (b.has(token)) shared.push(token);
  return shared.sort(); // sorted for determinism
};

/** Jaccard similarity |A∩B| / |A∪B| over normalized token sets. */
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  const sharedCount = intersect(a, b).length;
  const unionCount = a.size + b.size - sharedCount;
  return unionCount === 0 ? 0 : sharedCount / unionCount;
};

const answersByQuestion = (answers?: ScoringAnswer[] | null): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  for (const answer of answers ?? []) {
    if (!answer?.questionId) continue;
    const set = toTokenSet(answer.selectedOptionIds);
    if (set.size > 0) map.set(answer.questionId, set);
  }
  return map;
};

/**
 * Per-question Jaccard averaged across the questions BOTH couples answered.
 * Returns null when they share no answered questions (dimension absent).
 */
const answersSimilarity = (mine: ScoringCouple, theirs: ScoringCouple): number | null => {
  const mineByQ = answersByQuestion(mine.answers);
  const theirsByQ = answersByQuestion(theirs.answers);
  let total = 0;
  let count = 0;
  for (const [questionId, mineSet] of mineByQ) {
    const theirSet = theirsByQ.get(questionId);
    if (!theirSet) continue;
    total += jaccard(mineSet, theirSet);
    count += 1;
  }
  return count === 0 ? null : total / count;
};

/** Set similarity for a plain string[] dimension; null when either side is empty. */
const setSimilarity = (
  mine?: string[] | null,
  theirs?: string[] | null,
): number | null => {
  const a = toTokenSet(mine);
  const b = toTokenSet(theirs);
  if (a.size === 0 || b.size === 0) return null;
  return jaccard(a, b);
};

const normalizeCity = (city?: string | null): string =>
  (city ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const sharesCity = (mine: ScoringCouple, theirs: ScoringCouple): boolean => {
  const a = normalizeCity(mine.locationCity);
  const b = normalizeCity(theirs.locationCity);
  return a.length > 0 && a === b;
};

// ─── Scoring ──────────────────────────────────────────────────────────────────

/** Raw 0–100 compatibility before the display-floor remap. */
const rawScore = (mine: ScoringCouple, theirs: ScoringCouple): number => {
  const similarities: Array<{ weight: number; value: number }> = [];

  const answerSim = answersSimilarity(mine, theirs);
  if (answerSim !== null) similarities.push({ weight: DIMENSION_WEIGHTS.answers, value: answerSim });

  const activitySim = setSimilarity(mine.activities, theirs.activities);
  if (activitySim !== null) similarities.push({ weight: DIMENSION_WEIGHTS.activities, value: activitySim });

  const vibeSim = setSimilarity(mine.socialVibes, theirs.socialVibes);
  if (vibeSim !== null) similarities.push({ weight: DIMENSION_WEIGHTS.socialVibes, value: vibeSim });

  const criteriaSim = setSimilarity(mine.matchCriteria, theirs.matchCriteria);
  if (criteriaSim !== null) similarities.push({ weight: DIMENSION_WEIGHTS.matchCriteria, value: criteriaSim });

  const presentWeight = similarities.reduce((sum, s) => sum + s.weight, 0);
  const weighted = presentWeight === 0
    ? 0
    : similarities.reduce((sum, s) => sum + (s.weight / presentWeight) * s.value, 0);

  const cityBonus = sharesCity(mine, theirs) ? CITY_BONUS_POINTS : 0;
  const raw = weighted * SIMILARITY_POINTS + cityBonus;
  return Math.max(0, Math.min(100, raw));
};

/**
 * Deterministic 0–100 match score between two couples, floored at
 * {@link SCORE_FLOOR} (see its doc for why). Symmetric: scoreCouples(a, b)
 * always equals scoreCouples(b, a).
 */
export const scoreCouples = (mine: ScoringCouple, theirs: ScoringCouple): number => {
  const raw = rawScore(mine, theirs);
  return Math.round(SCORE_FLOOR + (raw * (100 - SCORE_FLOOR)) / 100);
};

// ─── Insights ─────────────────────────────────────────────────────────────────

const MAX_INSIGHTS = 2;

/**
 * Up to {@link MAX_INSIGHTS} short lines built ONLY from genuine overlaps —
 * never invented. Returns [] when the couples share nothing measurable (the
 * app shows its own neutral copy in that case). Deterministic: categories are
 * visited in fixed priority order and shared tokens are sorted.
 *
 * Copy stays warm and quiet per the product voice — statements about the two
 * couples, no urgency, no exclamation.
 */
export const generateInsights = (mine: ScoringCouple, theirs: ScoringCouple): string[] => {
  const insights: string[] = [];
  const push = (line: string): void => {
    if (insights.length < MAX_INSIGHTS && !insights.includes(line)) insights.push(line);
  };

  const mineByQ = answersByQuestion(mine.answers);
  const theirsByQ = answersByQuestion(theirs.answers);
  const sharedForQuestion = (questionId: string): string[] => {
    const a = mineByQ.get(questionId);
    const b = theirsByQ.get(questionId);
    return a && b ? intersect(a, b) : [];
  };

  // 1. Things they both love doing — q3 answers merged with activity chips.
  //    The strongest, most concrete overlap; may contribute both insights.
  const sharedLoves = Array.from(
    new Set([
      ...sharedForQuestion('q3'),
      ...intersect(toTokenSet(mine.activities), toTokenSet(theirs.activities)),
    ]),
  ).sort();
  for (const token of sharedLoves) push(`You both love ${token}`);

  // 2. Same meeting pace (q4 labels all begin with "meeting …").
  for (const token of sharedForQuestion('q4')) {
    push(`Similar pace - you both prefer ${token}`);
  }

  // 3. Same life stage (q1).
  for (const token of sharedForQuestion('q1')) {
    push(`You're in a similar life stage - ${token}`);
  }

  // 4. Same couple personality (q2).
  for (const token of sharedForQuestion('q2')) {
    push(`Same couple energy - ${token}`);
  }

  // 5. Shared social vibes (free-form field, phrased generically).
  for (const token of intersect(toTokenSet(mine.socialVibes), toTokenSet(theirs.socialVibes))) {
    push(`You share a love for ${token}`);
  }

  return insights;
};

// ─── Convenience ──────────────────────────────────────────────────────────────

/** Score + insights in one pass — what the discovery feed and match rows store. */
export const evaluateMatch = (
  mine: ScoringCouple,
  theirs: ScoringCouple,
): { matchScore: number; insights: string[] } => ({
  matchScore: scoreCouples(mine, theirs),
  insights: generateInsights(mine, theirs),
});

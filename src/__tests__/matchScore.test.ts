import {
  scoreCouples,
  generateInsights,
  evaluateMatch,
  SCORE_FLOOR,
  type ScoringCouple,
} from '../services/matchScore';

// Pure functions — no prisma, no mocks needed.

const richCouple = (): ScoringCouple => ({
  locationCity: 'Bangalore',
  activities: ['Weekend trips', 'Films', 'Cooking'],
  socialVibes: ['Quiet evenings'],
  matchCriteria: ['Shared interests'],
  answers: [
    { questionId: 'q1', selectedOptionIds: ['q1-career'] },
    { questionId: 'q2', selectedOptionIds: ['q2-planners'] },
    { questionId: 'q3', selectedOptionIds: ['q3-trips', 'q3-drinks'] },
    { questionId: 'q4', selectedOptionIds: ['q4-once-month'] },
  ],
});

const disjointCouple = (): ScoringCouple => ({
  locationCity: 'Mumbai',
  activities: ['Sports', 'Board games'],
  socialVibes: ['Big parties'],
  matchCriteria: ['Weekend availability'],
  answers: [
    { questionId: 'q1', selectedOptionIds: ['q1-family'] },
    { questionId: 'q2', selectedOptionIds: ['q2-hosts'] },
    { questionId: 'q3', selectedOptionIds: ['q3-outdoor'] },
    { questionId: 'q4', selectedOptionIds: ['q4-once-week'] },
  ],
});

describe('scoreCouples', () => {
  it('scores identical couples in the same city at 100', () => {
    expect(scoreCouples(richCouple(), richCouple())).toBe(100);
  });

  it('floors fully disjoint couples at SCORE_FLOOR', () => {
    expect(scoreCouples(richCouple(), disjointCouple())).toBe(SCORE_FLOOR);
  });

  it('floors two couples with no data at SCORE_FLOOR', () => {
    expect(scoreCouples({}, {})).toBe(SCORE_FLOOR);
  });

  it('scores partial overlap strictly between the floor and 100', () => {
    const partial: ScoringCouple = {
      ...disjointCouple(),
      locationCity: 'Bangalore', // shared city
      activities: ['Weekend trips', 'Sports'], // one shared activity
      answers: [
        { questionId: 'q1', selectedOptionIds: ['q1-career'] }, // shared life stage
        { questionId: 'q3', selectedOptionIds: ['q3-outdoor'] },
      ],
    };
    const score = scoreCouples(richCouple(), partial);
    expect(score).toBeGreaterThan(SCORE_FLOOR);
    expect(score).toBeLessThan(100);
  });

  it('is monotonic: more overlap never scores lower', () => {
    const someOverlap: ScoringCouple = {
      ...disjointCouple(),
      activities: ['Weekend trips'],
    };
    const moreOverlap: ScoringCouple = {
      ...someOverlap,
      locationCity: 'Bangalore',
      answers: [{ questionId: 'q4', selectedOptionIds: ['q4-once-month'] }],
    };
    expect(scoreCouples(richCouple(), moreOverlap)).toBeGreaterThanOrEqual(
      scoreCouples(richCouple(), someOverlap),
    );
  });

  it('is deterministic and symmetric', () => {
    const a = richCouple();
    const b = disjointCouple();
    b.activities = ['Weekend trips', 'Sports']; // some overlap so the value is non-trivial
    const first = scoreCouples(a, b);
    expect(scoreCouples(a, b)).toBe(first);
    expect(scoreCouples(b, a)).toBe(first);
  });

  it('excludes dimensions where either couple has no data instead of zeroing them', () => {
    // Identical answers + same city; the empty activities/vibes/criteria fields
    // must not drag the score down (absence of data is not disagreement).
    const sparse: ScoringCouple = {
      locationCity: 'Goa',
      answers: [{ questionId: 'q2', selectedOptionIds: ['q2-explorers'] }],
    };
    expect(scoreCouples(sparse, { ...sparse })).toBe(100);
  });

  it('matches option ids against legacy stored titles (normalization)', () => {
    const withIds: ScoringCouple = {
      answers: [{ questionId: 'q3', selectedOptionIds: ['q3-trips'] }],
    };
    const withTitles: ScoringCouple = {
      answers: [{ questionId: 'q3', selectedOptionIds: ['Weekend trips'] }],
    };
    // A title-stored legacy row must score exactly like the id-stored form…
    expect(scoreCouples(withIds, withTitles)).toBe(scoreCouples(withIds, { ...withIds }));
    // …which is a perfect answers match (city unknown → no proximity claim, so
    // the +10 city bonus is honestly withheld and 100 is not reachable here).
    expect(scoreCouples(withIds, withTitles)).toBeGreaterThan(90);
  });

  it('keeps the same-city bonus additive: city alone stays near the floor', () => {
    const cityOnlyA: ScoringCouple = { locationCity: 'Bangalore' };
    const cityOnlyB: ScoringCouple = { locationCity: 'bangalore ' }; // case/space-insensitive
    const score = scoreCouples(cityOnlyA, cityOnlyB);
    expect(score).toBeGreaterThan(SCORE_FLOOR);
    expect(score).toBeLessThanOrEqual(SCORE_FLOOR + 5);
  });
});

describe('generateInsights', () => {
  it('builds an insight from a genuinely shared q3 activity', () => {
    const insights = generateInsights(richCouple(), {
      answers: [{ questionId: 'q3', selectedOptionIds: ['q3-trips'] }],
    });
    expect(insights).toContain('You both love weekend trips');
  });

  it('returns [] when nothing genuine is shared — never invents copy', () => {
    expect(generateInsights(richCouple(), disjointCouple())).toEqual([]);
    expect(generateInsights({}, {})).toEqual([]);
  });

  it('caps at two insights', () => {
    expect(generateInsights(richCouple(), richCouple())).toHaveLength(2);
  });

  it('is deterministic across calls and prioritizes shared loves', () => {
    const theirs: ScoringCouple = {
      activities: ['Cooking', 'Films'],
      answers: [
        { questionId: 'q3', selectedOptionIds: ['q3-drinks'] },
        { questionId: 'q4', selectedOptionIds: ['q4-once-month'] },
      ],
    };
    const first = generateInsights(richCouple(), theirs);
    expect(generateInsights(richCouple(), theirs)).toEqual(first);
    // Shared loves come first (alphabetical within the category), pace after.
    expect(first).toEqual(['You both love casual drinks', 'You both love cooking']);
  });

  it('falls through to pace/life-stage insights when no activities are shared', () => {
    const mine: ScoringCouple = {
      answers: [
        { questionId: 'q1', selectedOptionIds: ['q1-growing'] },
        { questionId: 'q4', selectedOptionIds: ['q4-twice-month'] },
      ],
    };
    const theirs: ScoringCouple = {
      answers: [
        { questionId: 'q1', selectedOptionIds: ['q1-growing'] },
        { questionId: 'q4', selectedOptionIds: ['q4-twice-month'] },
      ],
    };
    expect(generateInsights(mine, theirs)).toEqual([
      'Similar pace - you both prefer meeting twice a month',
      "You're in a similar life stage - growing together",
    ]);
  });
});

describe('evaluateMatch', () => {
  it('returns the same values as the underlying functions', () => {
    const mine = richCouple();
    const theirs = disjointCouple();
    theirs.activities = ['Weekend trips'];
    const result = evaluateMatch(mine, theirs);
    expect(result.matchScore).toBe(scoreCouples(mine, theirs));
    expect(result.insights).toEqual(generateInsights(mine, theirs));
  });

  it('keeps the response contract: numeric score in [floor, 100], string[] insights', () => {
    const { matchScore, insights } = evaluateMatch(richCouple(), disjointCouple());
    expect(typeof matchScore).toBe('number');
    expect(matchScore).toBeGreaterThanOrEqual(SCORE_FLOOR);
    expect(matchScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(insights)).toBe(true);
    insights.forEach((i) => expect(typeof i).toBe('string'));
  });
});

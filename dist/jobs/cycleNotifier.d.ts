/**
 * Cycle Notifier Job
 * ─────────────────────────────────────────────────────────────────────────
 * Once a day (checked every 30 min, sent between 08:00–21:00 IST) this job
 * looks at every couple that has cycle data and, on milestone days, nudges
 * the PRIMARY partner (the boyfriend) with a caring heads-up:
 *   • period start      → "be extra gentle and caring"
 *   • fertile window    → "a little extra love goes a long way"
 *   • ovulation day     → "treat her with chocolates, make her feel special"
 *   • PMS days          → "extra patience and warm hugs"
 *
 * The girl (partner role) sets the data; she never receives these nudges —
 * `senderUserId` is set to her id so the client filters them out for her.
 */
export type CycleSettings = {
    lastPeriodStart: string;
    periodLength: number;
    cycleLength: number;
    updatedBy?: string;
    updatedByName?: string;
    updatedAt?: string;
};
export declare const cycleKey: (coupleId: string) => string;
export declare const CYCLE_INDEX_KEY = "us:cycle_index";
export declare const CYCLE_TTL: number;
/** 1-based day within the (predicted) cycle for a YYYY-MM-DD date. */
export declare function cycleDayFor(dateStr: string, s: CycleSettings): number;
export declare function runCheck(): Promise<void>;
/** Start the notifier — immediate check on boot, then every 30 minutes. */
export declare const startCycleNotifier: () => void;
//# sourceMappingURL=cycleNotifier.d.ts.map
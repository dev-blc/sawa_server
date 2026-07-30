export type GooglePurchaseState = 'ACTIVE' | 'GRACE' | 'ON_HOLD' | 'PAUSED' | 'CANCELED' | 'EXPIRED' | 'PENDING' | 'UNKNOWN';
export interface GoogleSubInfo {
    productId: string | null;
    expiryMs: number;
    state: GooglePurchaseState;
    autoRenew: boolean;
    acknowledged: boolean;
    linkedPurchaseToken: string | null;
}
export declare const isGoogleConfigured: () => boolean;
/**
 * Fetch the authoritative subscription state for a purchase token
 * (purchases.subscriptionsv2.get). Returns null on any failure.
 */
export declare const getSubscriptionV2: (purchaseToken: string) => Promise<GoogleSubInfo | null>;
/**
 * Acknowledge a subscription purchase so Google does not auto-refund it.
 * Idempotent — safe to call even if the client already acknowledged.
 */
export declare const acknowledgeSubscription: (productId: string, purchaseToken: string) => Promise<void>;
//# sourceMappingURL=googleplay.service.d.ts.map
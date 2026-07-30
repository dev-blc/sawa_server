import { type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';
export declare const isAppleConfigured: () => boolean;
/**
 * Ask Apple for the authoritative signed transaction, verify it, and return the
 * decoded payload. Tries Production first, then Sandbox (per Apple guidance) so
 * the same code path works for App Store, TestFlight and sandbox testers.
 */
export declare const verifyTransactionById: (transactionId: string) => Promise<JWSTransactionDecodedPayload | null>;
/**
 * Verify + decode an App Store Server Notification V2 signedPayload.
 * Tries both environment verifiers.
 */
export declare const decodeNotification: (signedPayload: string) => Promise<ResponseBodyV2DecodedPayload | null>;
/** Verify + decode a single signed transaction string (used inside notifications). */
export declare const decodeSignedTransaction: (signedTransactionInfo: string) => Promise<JWSTransactionDecodedPayload | null>;
//# sourceMappingURL=appstore.service.d.ts.map
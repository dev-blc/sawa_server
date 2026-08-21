// Augment Express Request with the authenticated caller (set by
// middleware/authenticate.ts and middleware/adminAuth.ts from the verified JWT).
//
// NOTE: adminAuth.ts re-declares `user` inline; TypeScript's declaration
// merging (TS2717) requires every `user` declaration to be IDENTICAL, so any
// change to this shape must be mirrored there byte-for-byte. New request-scoped
// auth data goes on its own property (like `accessToken` below), never onto
// `user`, precisely to avoid another three-way merge conflict.
export {};

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        coupleMongoId?: string;
        coupleId?: string;
        userName?: string;
        role?: string;
      };
      /**
       * Verified access-token metadata (set by middleware/authenticate.ts).
       * The logout handler passes `jti` + `exp` down so the presented token can
       * be denylisted for exactly its remaining lifetime (utils/jwt.ts, H4).
       */
      accessToken?: {
        jti?: string;
        exp?: number;
      };
    }
  }
}

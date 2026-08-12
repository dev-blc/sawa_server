"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authService = exports.AuthService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const otp_service_1 = require("./otp.service");
const user_repository_1 = require("../repositories/user.repository");
const jwt_1 = require("../utils/jwt");
const AppError_1 = require("../utils/AppError");
const prisma_1 = require("../lib/prisma");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
/** Set of phone numbers (with country code) that skip OTP — for test / demo accounts */
const getBypassPhones = () => {
    if (!env_1.env.BYPASS_PHONES)
        return new Set();
    // Secure-by-default: the OTP bypass is a testing/demo backdoor and is DISABLED
    // in production unless an operator explicitly opts in with
    // BYPASS_PHONES_ALLOW_PROD=true. This prevents accidentally shipping a
    // permanent OTP-less login for the listed numbers.
    if (env_1.env.NODE_ENV === 'production' && process.env.BYPASS_PHONES_ALLOW_PROD !== 'true') {
        logger_1.logger.warn('[auth] BYPASS_PHONES is set but ignored in production (set BYPASS_PHONES_ALLOW_PROD=true to force).');
        return new Set();
    }
    return new Set(env_1.env.BYPASS_PHONES.split(',').map(p => p.trim()).filter(Boolean));
};
/**
 * Throws if the couple is banned by an admin. Both partners share the ban.
 * Called from every login path so a fresh OTP can't bypass an active ban.
 */
const assertNotBanned = async (coupleId) => {
    if (!coupleId)
        return;
    const couple = await prisma_1.prisma.couple.findUnique({
        where: { coupleId },
        select: { bannedAt: true },
    });
    if (couple?.bannedAt) {
        throw new AppError_1.AppError('This account has been suspended. Please contact support.', 403, 'ACCOUNT_BANNED');
    }
};
class AuthService {
    /**
     * STEP 1 — Send OTP
     */
    async sendOtp(yourPhone, partnerPhone) {
        if (yourPhone === partnerPhone) {
            throw new AppError_1.AppError('Your number and partner number cannot be the same', 400, 'SAME_NUMBER');
        }
        const existingYours = await user_repository_1.userRepository.findByPhone(yourPhone);
        const existingPartner = await user_repository_1.userRepository.findByPhone(partnerPhone);
        if (existingYours && existingYours.isPhoneVerified) {
            throw new AppError_1.AppError('This number is already registered. Please Sign In instead.', 400, 'USER_EXISTS');
        }
        if (existingPartner && existingPartner.isPhoneVerified) {
            throw new AppError_1.AppError('Partner number is already registered to another account.', 400, 'PARTNER_EXISTS');
        }
        // If either phone belongs to a partially-registered banned couple, block reuse.
        await assertNotBanned(existingYours?.coupleId);
        await assertNotBanned(existingPartner?.coupleId);
        const coupleId = crypto_1.default.randomUUID();
        // One upsert (not two) — FK constraint satisfied before user rows are created.
        await prisma_1.prisma.couple.upsert({
            where: { coupleId },
            update: {},
            create: { coupleId, profileName: 'Sawa Couple' },
        });
        // Both user rows + both OTPs can be kicked off in parallel once the couple row exists.
        const appUrl = (env_1.env.APP_URL || 'https://sawa.living').replace(/\/$/, '');
        const partnerCodeMsg = `Welcome to SAWA! Use {{code}} to verify your shared profile. Download here: ${appUrl}/app`;
        await Promise.all([
            user_repository_1.userRepository.upsertByPhone(yourPhone, coupleId, 'primary'),
            user_repository_1.userRepository.upsertByPhone(partnerPhone, coupleId, 'partner'),
        ]);
        // keepValidPrevious=true — mirror the login flow. If "Send Code" fires more
        // than once (double-tap, screen re-mount, slow-network retry) the earlier
        // still-valid code from the FIRST SMS keeps working, so the user never sees a
        // spurious "Invalid or expired OTP" for a code they only generated once.
        await Promise.all([
            otp_service_1.otpService.generateAndStore(yourPhone, coupleId, undefined, true),
            otp_service_1.otpService.generateAndStore(partnerPhone, coupleId, partnerCodeMsg, true),
        ]);
        logger_1.logger.info(`[AuthService] OTPs issued for entity: ${coupleId}`);
        return { coupleId };
    }
    /**
     * STEP 2 — Verify OTP
     */
    async verifyOtp(yourPhone, yourOtp, partnerPhone, partnerOtp) {
        // Verify OTPs and fetch existing user records in one parallel shot.
        const [yourResult, partnerResult, existingYours, existingPartner] = await Promise.all([
            otp_service_1.otpService.verify(yourPhone, yourOtp),
            otp_service_1.otpService.verify(partnerPhone, partnerOtp),
            user_repository_1.userRepository.findByPhone(yourPhone),
            user_repository_1.userRepository.findByPhone(partnerPhone),
        ]);
        if (!yourResult.valid) {
            throw new AppError_1.AppError('Your OTP is invalid or expired', 400, 'INVALID_OTP');
        }
        if (!partnerResult.valid) {
            throw new AppError_1.AppError("Partner's OTP is invalid or expired", 400, 'INVALID_PARTNER_OTP');
        }
        const coupleId = yourResult.coupleId;
        const defaultName = (existingYours?.name || existingPartner?.name)
            ? `${existingYours?.name || 'User'} & ${existingPartner?.name || 'Partner'}`
            : 'Sawa Couple';
        // Ensure couple row exists (FK constraint) then upsert users in parallel.
        const couple = await prisma_1.prisma.couple.upsert({
            where: { coupleId },
            update: {},
            create: { coupleId, profileName: defaultName, isProfileComplete: false, isSubscribed: false },
        });
        await Promise.all([
            user_repository_1.userRepository.upsertByPhone(yourPhone, coupleId, 'primary'),
            user_repository_1.userRepository.upsertByPhone(partnerPhone, coupleId, 'partner'),
        ]);
        const [yourUser, partnerUser] = await Promise.all([
            user_repository_1.userRepository.markVerified(yourPhone),
            user_repository_1.userRepository.markVerified(partnerPhone),
        ]);
        // `couple` is already available from the upsert above — no extra findUnique needed.
        const yourAccessToken = (0, jwt_1.signAccessToken)({
            userId: yourUser.id,
            coupleMongoId: couple?.id || undefined,
            coupleId,
        });
        const yourRefreshToken = (0, jwt_1.signRefreshToken)({
            userId: yourUser.id,
            coupleMongoId: couple?.id || undefined,
            coupleId,
        });
        const partnerAccessToken = (0, jwt_1.signAccessToken)({
            userId: partnerUser.id,
            coupleMongoId: couple?.id || undefined,
            coupleId,
        });
        const partnerRefreshToken = (0, jwt_1.signRefreshToken)({
            userId: partnerUser.id,
            coupleMongoId: couple?.id || undefined,
            coupleId,
        });
        await Promise.all([
            user_repository_1.userRepository.saveRefreshTokenHash(yourUser.id, hashToken(yourRefreshToken)),
            user_repository_1.userRepository.saveRefreshTokenHash(partnerUser.id, hashToken(partnerRefreshToken)),
        ]);
        return {
            coupleId,
            yourToken: { accessToken: yourAccessToken, refreshToken: yourRefreshToken },
            partnerToken: { accessToken: partnerAccessToken, refreshToken: partnerRefreshToken },
            yourUser: {
                id: yourUser.id,
                name: yourUser.name || '',
                role: yourUser.role
            }
        };
    }
    /**
     * STEP 3 — Refresh
     */
    async refreshAccessToken(refreshToken) {
        const payload = (0, jwt_1.verifyRefreshToken)(refreshToken);
        const user = await user_repository_1.userRepository.findByIdWithRefreshToken(payload.userId);
        if (!user || !user.refreshTokenHash) {
            throw new AppError_1.AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
        }
        // Constant-time compare of the stored vs presented refresh-token hash.
        const presented = Buffer.from(hashToken(refreshToken), 'utf8');
        const stored = Buffer.from(user.refreshTokenHash, 'utf8');
        if (presented.length !== stored.length || !crypto_1.default.timingSafeEqual(presented, stored)) {
            throw new AppError_1.AppError('Refresh token mismatch', 401, 'INVALID_REFRESH_TOKEN');
        }
        const resolvedCoupleId = payload.coupleId ?? user.coupleId ?? undefined;
        const accessToken = (0, jwt_1.signAccessToken)({
            userId: user.id,
            coupleMongoId: payload.coupleMongoId,
            coupleId: resolvedCoupleId,
        });
        // Rolling refresh — issue a fresh refresh token so the session
        // keeps extending as long as the user is active.
        const newRefreshToken = (0, jwt_1.signRefreshToken)({
            userId: user.id,
            coupleMongoId: payload.coupleMongoId,
            coupleId: resolvedCoupleId,
        });
        await user_repository_1.userRepository.saveRefreshTokenHash(user.id, hashToken(newRefreshToken));
        return { accessToken, refreshToken: newRefreshToken };
    }
    /**
     * STEP 4 — Logout
     */
    async logout(userId) {
        await user_repository_1.userRepository.clearRefreshToken(userId);
    }
    /**
     * LOGIN STEP 1
     * For bypass phones: skips OTP entirely and returns access/refresh tokens immediately.
     * For normal phones: sends OTP and returns only the coupleId.
     */
    async loginSendOtp(phone) {
        const user = await user_repository_1.userRepository.findByPhone(phone);
        if (!user) {
            throw new AppError_1.AppError('No account found with this number.', 404, 'USER_NOT_FOUND');
        }
        await assertNotBanned(user.coupleId);
        // ── Bypass: issue tokens immediately, no OTP needed ──────────────────────
        if (getBypassPhones().has(phone)) {
            logger_1.logger.info(`[AuthService] Bypass login for ${phone}`);
            const couple = user.coupleId
                ? await prisma_1.prisma.couple.upsert({
                    where: { coupleId: user.coupleId },
                    update: {},
                    create: { coupleId: user.coupleId, profileName: user.name || 'Sawa Couple', isProfileComplete: false, isSubscribed: false },
                })
                : null;
            const accessToken = (0, jwt_1.signAccessToken)({
                userId: user.id,
                coupleMongoId: couple?.id || undefined,
                coupleId: user.coupleId || undefined,
            });
            const refreshToken = (0, jwt_1.signRefreshToken)({
                userId: user.id,
                coupleMongoId: couple?.id || undefined,
                coupleId: user.coupleId || undefined,
            });
            await user_repository_1.userRepository.saveRefreshTokenHash(user.id, hashToken(refreshToken));
            return {
                coupleId: user.coupleId || '',
                bypass: true,
                accessToken,
                refreshToken,
                profile: couple ? { ...couple, _id: couple.id } : null,
                user: { id: user.id, name: user.name || '', role: user.role },
            };
        }
        // ── Normal flow ───────────────────────────────────────────────────────────
        // If the user row somehow has no coupleId (legacy / migration gap), try
        // to find their couple via the Couple table's partner references before
        // falling back to an empty string (which would cause loginVerifyOtp to
        // generate a fresh UUID and create a new couple from scratch).
        let resolvedCoupleId = user.coupleId;
        if (!resolvedCoupleId) {
            const linked = await prisma_1.prisma.couple.findFirst({
                where: { OR: [{ partner1Id: user.id }, { partner2Id: user.id }] },
                select: { coupleId: true },
            });
            resolvedCoupleId = linked?.coupleId ?? null;
            if (resolvedCoupleId) {
                // Repair the stale user row so future logins won't need this lookup.
                await prisma_1.prisma.user.update({ where: { id: user.id }, data: { coupleId: resolvedCoupleId } });
            }
        }
        // keepValidPrevious=true — don't wipe a still-valid code the user may already
        // have received; avoids "Invalid or expired OTP" when an earlier code is used.
        await otp_service_1.otpService.generateAndStore(phone, resolvedCoupleId || '', undefined, true);
        return { coupleId: resolvedCoupleId || '' };
    }
    /**
     * LOGIN STEP 2
     */
    async loginVerifyOtp(phone, otp) {
        // OTP verify + user lookup in parallel — saves one DB round trip.
        const [result, user] = await Promise.all([
            otp_service_1.otpService.verify(phone, otp),
            user_repository_1.userRepository.findByPhone(phone),
        ]);
        // Only check OTP validity — do NOT gate on coupleId here, since accounts
        // registered before coupleId was reliably stored may have an empty coupleId.
        if (!result.valid) {
            throw new AppError_1.AppError('Invalid or expired OTP', 400, 'INVALID_OTP');
        }
        if (!user) {
            throw new AppError_1.AppError('No account found with this number.', 404, 'USER_NOT_FOUND');
        }
        // Resolve coupleId with priority:
        //   1. The user row's own coupleId (most authoritative)
        //   2. The coupleId stored with the OTP token (set during loginSendOtp)
        //   3. A couple where this user is partner1 or partner2 (handles legacy rows)
        //   4. A fresh UUID (absolute last resort — new account scenario)
        let coupleId = user.coupleId || result.coupleId || '';
        if (!coupleId) {
            // Neither the user row nor the OTP token has a coupleId — look up via
            // the Couple table's partner references to avoid creating a duplicate couple.
            const linked = await prisma_1.prisma.couple.findFirst({
                where: { OR: [{ partner1Id: user.id }, { partner2Id: user.id }] },
                select: { coupleId: true },
            });
            coupleId = linked?.coupleId ?? crypto_1.default.randomUUID();
        }
        // Persist the coupleId back to the user row if it was missing or stale.
        if (!user.coupleId || user.coupleId !== coupleId) {
            await prisma_1.prisma.user.update({ where: { id: user.id }, data: { coupleId } });
        }
        await assertNotBanned(coupleId);
        // Upsert couple (handles missing row) — single query, not a find + conditional create.
        const couple = await prisma_1.prisma.couple.upsert({
            where: { coupleId },
            update: {},
            create: {
                coupleId,
                profileName: user.name || 'Sawa Couple',
                isProfileComplete: false,
                isSubscribed: false,
            },
        });
        const accessToken = (0, jwt_1.signAccessToken)({
            userId: user.id,
            coupleMongoId: couple.id,
            coupleId,
        });
        const refreshToken = (0, jwt_1.signRefreshToken)({
            userId: user.id,
            coupleMongoId: couple.id,
            coupleId,
        });
        await user_repository_1.userRepository.saveRefreshTokenHash(user.id, hashToken(refreshToken));
        return {
            coupleId,
            token: { accessToken, refreshToken },
            profile: { ...couple, _id: couple.id },
            user: {
                id: user.id,
                _id: user.id,
                name: user.name || '',
                role: user.role,
            },
        };
    }
    /**
     * RESEND OTP — only for one phone at a time.
     * Reuses the existing coupleId so the other partner's OTP is NOT affected.
     * Safe to call multiple times; each call replaces only that phone's OTP.
     */
    async resendOtp(phone) {
        // Find the coupleId from the existing OTP record for this phone
        const existingToken = await prisma_1.prisma.otpToken.findFirst({
            where: { phone },
            orderBy: { createdAt: 'desc' },
            select: { coupleId: true },
        });
        let coupleId = existingToken?.coupleId;
        // Fallback: look up the user record (handles edge case where OTP was already verified/expired)
        if (!coupleId) {
            const user = await user_repository_1.userRepository.findByPhone(phone);
            coupleId = user?.coupleId ?? undefined;
        }
        if (!coupleId) {
            throw new AppError_1.AppError('No active signup session found for this number. Please start registration again.', 400, 'NO_SESSION');
        }
        // Regenerate OTP for this phone only — partner's OTP is untouched.
        // keepValidPrevious=true so the previously-sent code still works if the user
        // enters it (common: they resend, then auto-fill grabs the first SMS).
        await otp_service_1.otpService.generateAndStore(phone, coupleId, undefined, true);
        logger_1.logger.info(`[AuthService] OTP resent for ${phone} (coupleId: ${coupleId})`);
    }
    async sendPartnerInvite(partnerPhone) {
        // Use the server's /app page which auto-detects Android vs iOS and redirects
        // to Play Store or App Store accordingly. Falls back to sawa.living if no APP_URL.
        const appUrl = (env_1.env.APP_URL || 'https://sawa.living').replace(/\/$/, '');
        const inviteLink = `${appUrl}/app`;
        const msg = `Hi! Your partner has invited you to join them on SAWA — the app for couples. Download here: ${inviteLink}`;
        return otp_service_1.otpService.sendInvitation(partnerPhone, msg);
    }
}
exports.AuthService = AuthService;
const hashToken = (token) => crypto_1.default.createHash('sha256').update(token).digest('hex');
exports.authService = new AuthService();
//# sourceMappingURL=auth.service.js.map
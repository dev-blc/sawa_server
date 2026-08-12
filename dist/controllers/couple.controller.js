"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unblockCommunity = exports.getBlockedCommunities = exports.unblockCouple = exports.blockCouple = exports.getBlockList = exports.deleteMyAccount = exports.getCoupleById = exports.subscribe = exports.invitePartner = exports.updateMyCouple = exports.getMyCouple = exports.createCouple = exports.completeOnboarding = exports.submitAnswers = exports.getOnboardingStatus = exports.uploadPhotos = exports.setupProfile = exports.validateUpdateMyCouple = exports.validateCompleteOnboarding = exports.validateSubmitAnswers = exports.validateUploadPhotos = exports.validateSetupProfile = void 0;
const zod_1 = require("zod");
const couple_service_1 = require("../services/couple.service");
const prisma_1 = require("../lib/prisma");
const response_1 = require("../utils/response");
const validate_1 = require("../middleware/validate");
const AppError_1 = require("../utils/AppError");
const subscription_1 = require("../config/subscription");
const cache_1 = require("../lib/cache");
// ─── Onboarding step derivation ─────────────────────────────────────────────
/**
 * Derives the onboarding step a couple should resume from, based on what's
 * already persisted in the DB. No extra DB fields required.
 *
 * Steps (in order):
 *   OnboardingLanguage → ProfileSetup → StoryPhoto → Question →
 *   PermissionRequest → Complete
 */
function deriveOnboardingStep(couple) {
    if (couple.isProfileComplete)
        return 'Complete';
    // Answers saved → ready for PermissionRequest ("I'm in!" screen)
    if (couple.answers && couple.answers.length > 0)
        return 'PermissionRequest';
    // Primary photo saved → ready for Question
    if (couple.primaryPhoto)
        return 'Question';
    // Profile name set (not the default) AND partner linked → ready for StoryPhoto
    const hasRealName = couple.profileName &&
        couple.profileName !== 'Sawa Couple' &&
        couple.profileName.trim().length > 0;
    if (hasRealName && couple.partner1Id)
        return 'StoryPhoto';
    // Nothing saved yet — start from language selection
    return 'OnboardingLanguage';
}
// ─── Validation ─────────────────────────────────────────────────────────────
// Parse a DOB string to age in years, or null if unparseable. Accepts the app's
// DD/MM/YYYY display format and ISO (YYYY-MM-DD).
const ageFromDobString = (dob) => {
    const s = String(dob).trim();
    if (!s)
        return null;
    let y, m, d;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
        y = +iso[1];
        m = +iso[2];
        d = +iso[3];
    }
    else {
        const parts = s.replace(/[^0-9]/g, '/').split('/').filter(Boolean);
        if (parts.length < 3)
            return null;
        d = +parts[0];
        m = +parts[1];
        y = +parts[2];
    }
    if (!d || !m || !y || y < 1900)
        return null;
    const birth = new Date(y, m - 1, d);
    if (Number.isNaN(birth.getTime()))
        return null;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const md = now.getMonth() - birth.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < birth.getDate()))
        age--;
    return age;
};
// Optional DOB that, WHEN present and parseable, must be >= 18 (Sawa is 18+).
// Server-side backstop for the client age gate. Empty / absent / unparseable
// values pass through so older app builds that omit DOB aren't broken; only a
// clearly-parseable under-18 date is rejected.
const optionalAdultDob = zod_1.z
    .string()
    .optional()
    .or(zod_1.z.literal(''))
    .refine((v) => {
    if (!v)
        return true;
    const age = ageFromDobString(v);
    return age === null || age >= 18;
}, { message: 'You must be 18 or older to use Sawa' });
const SetupProfileSchema = zod_1.z.object({
    yourName: zod_1.z.string().min(1, 'Your name is required'),
    yourEmail: zod_1.z.string().optional().or(zod_1.z.literal('')),
    yourDob: optionalAdultDob,
    partnerName: zod_1.z.string().min(1, "Partner's name is required"),
    partnerEmail: zod_1.z.string().optional().or(zod_1.z.literal('')),
    partnerDob: optionalAdultDob,
    relationshipStatus: zod_1.z.string().optional(),
    location: zod_1.z.object({
        city: zod_1.z.string().optional(),
        country: zod_1.z.string().optional(),
    }).optional(),
});
const UploadPhotosSchema = zod_1.z.object({
    primaryPhotoBase64: zod_1.z.string().optional(),
    secondaryPhotosBase64: zod_1.z.array(zod_1.z.string()).max(3).optional(),
    keepSecondaryPhotoUrls: zod_1.z.array(zod_1.z.string()).optional(),
});
const SubmitAnswersSchema = zod_1.z.object({
    answers: zod_1.z.array(zod_1.z.object({
        questionId: zod_1.z.string(),
        selectedOptionIds: zod_1.z.array(zod_1.z.string()),
    })),
});
const CompleteOnboardingSchema = zod_1.z.object({
    // Profile fields are optional — each step saves data to the server immediately,
    // so a reinstall scenario (no local cache) still works because the DB already
    // has the data from earlier steps.  We only call setupProfile when names are present.
    yourName: zod_1.z.string().min(1).optional().or(zod_1.z.literal('')),
    yourEmail: zod_1.z.string().optional().or(zod_1.z.literal('')),
    yourDob: optionalAdultDob,
    partnerName: zod_1.z.string().min(1).optional().or(zod_1.z.literal('')),
    partnerEmail: zod_1.z.string().optional().or(zod_1.z.literal('')),
    partnerDob: optionalAdultDob,
    relationshipStatus: zod_1.z.string().optional(),
    primaryPhotoBase64: zod_1.z.string().optional(),
    secondaryPhotosBase64: zod_1.z.array(zod_1.z.string()).max(3).optional(),
    answers: zod_1.z.array(zod_1.z.object({
        questionId: zod_1.z.string(),
        selectedOptionIds: zod_1.z.array(zod_1.z.string()),
    })).optional().default([]),
    location: zod_1.z.object({
        city: zod_1.z.string().optional(),
        country: zod_1.z.string().optional(),
    }).optional(),
});
const UpdateMyCoupleSchema = zod_1.z.object({
    bio: zod_1.z.string().optional(),
    relationshipStatus: zod_1.z.string().optional(),
    isOpenToMeeting: zod_1.z.boolean().optional(),
    preferences: zod_1.z.any().optional(),
    activities: zod_1.z.array(zod_1.z.string()).optional(),
    matchCriteria: zod_1.z.union([zod_1.z.string(), zod_1.z.array(zod_1.z.string())]).optional(),
    yourName: zod_1.z.string().optional(),
    yourDob: zod_1.z.string().optional(),
    yourEmail: zod_1.z.string().optional(),
    partnerName: zod_1.z.string().optional(),
    partnerDob: zod_1.z.string().optional(),
    partnerEmail: zod_1.z.string().optional(),
    location: zod_1.z
        .object({
        city: zod_1.z.string().optional(),
        country: zod_1.z.string().optional(),
    })
        .optional(),
    locationCity: zod_1.z.string().optional(),
    locationCountry: zod_1.z.string().optional(),
    locationLatitude: zod_1.z.number().optional(),
    locationLongitude: zod_1.z.number().optional(),
});
exports.validateSetupProfile = (0, validate_1.validate)(SetupProfileSchema);
exports.validateUploadPhotos = (0, validate_1.validate)(UploadPhotosSchema);
exports.validateSubmitAnswers = (0, validate_1.validate)(SubmitAnswersSchema);
exports.validateCompleteOnboarding = (0, validate_1.validate)(CompleteOnboardingSchema);
exports.validateUpdateMyCouple = (0, validate_1.validate)(UpdateMyCoupleSchema);
// ─── Controllers ────────────────────────────────────────────────────────────
/**
 * POST /api/v1/couples/onboarding/profile
 * Saves name, dob, email for both primary and partner users,
 * and relationship status for the couple.
 * Lazily creates the Couple document if it doesn't exist.
 */
const setupProfile = async (req, res) => {
    const { userId, coupleId } = req.user;
    const data = req.body;
    await couple_service_1.coupleService.setupProfile(userId, coupleId, data);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Profile details saved' });
};
exports.setupProfile = setupProfile;
/**
 * POST /api/v1/couples/onboarding/photos
 * Simulates uploading base64 photos to a CDN/storage.
 */
const uploadPhotos = async (req, res) => {
    const { coupleId } = req.user;
    const data = req.body;
    await couple_service_1.coupleService.uploadPhotos(coupleId, data);
    await (0, cache_1.invalidateCoupleProfile)(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Photos uploaded successfully' });
};
exports.uploadPhotos = uploadPhotos;
/**
 * GET /api/v1/couples/onboarding/status
 * Returns the step the couple should resume onboarding from, derived purely
 * from the data already in the DB.  Safe to call on every login.
 */
const getOnboardingStatus = async (req, res) => {
    const { coupleId, userId } = req.user;
    const couple = await prisma_1.prisma.couple.findUnique({
        where: { coupleId: coupleId },
        select: {
            profileName: true,
            partner1Id: true,
            partner2Id: true,
            primaryPhoto: true,
            relationshipStatus: true,
            isProfileComplete: true,
            answers: { select: { id: true } },
            partner1: { select: { id: true, name: true, dob: true, email: true } },
            partner2: { select: { id: true, name: true, dob: true, email: true } },
        },
    });
    if (!couple) {
        throw new AppError_1.AppError('Couple not found', 404);
    }
    const step = deriveOnboardingStep(couple);
    // Return partial profile data so the client can pre-fill onboarding forms
    // after a reinstall without asking the user to retype everything.
    // "your" = the logged-in user, "partner" = the other person.
    const isPartner1 = couple.partner1Id === userId;
    const me = isPartner1 ? couple.partner1 : couple.partner2;
    const other = isPartner1 ? couple.partner2 : couple.partner1;
    const resumeData = {
        step,
        isComplete: couple.isProfileComplete,
        profile: {
            profileName: couple.profileName,
            relationshipStatus: couple.relationshipStatus,
            yourName: me?.name ?? null,
            yourDob: me?.dob ?? null,
            yourEmail: me?.email ?? null,
            partnerName: other?.name ?? null,
            partnerDob: other?.dob ?? null,
            partnerEmail: other?.email ?? null,
        },
        hasPhoto: !!couple.primaryPhoto,
        hasAnswers: (couple.answers?.length ?? 0) > 0,
        userId,
    };
    (0, response_1.sendSuccess)({ res, data: resumeData });
};
exports.getOnboardingStatus = getOnboardingStatus;
/**
 * POST /api/v1/couples/onboarding/answers
 * Saves onboarding questionnaire answers and marks profile as complete.
 */
const submitAnswers = async (req, res) => {
    const { coupleId } = req.user;
    const data = req.body;
    await couple_service_1.coupleService.submitAnswers(coupleId, data.answers);
    await (0, cache_1.invalidateCoupleProfile)(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Onboarding completed successfully' });
};
exports.submitAnswers = submitAnswers;
/**
 * POST /api/v1/couples/onboarding/complete
 * Combines profile, photos, and answers in one single unified flow.
 */
const completeOnboarding = async (req, res) => {
    const { userId, coupleId } = req.user;
    const data = req.body;
    console.log(`[CoupleController] completeOnboarding START for coupleId: ${coupleId}`);
    try {
        // 1. Only run setupProfile when names are present in the payload.
        //    Each onboarding step already saves to the server immediately, so on a
        //    reinstall the profile data lives in the DB — we just skip re-saving it.
        const hasProfileData = data.yourName && data.yourName.trim().length > 0
            && data.partnerName && data.partnerName.trim().length > 0;
        if (hasProfileData) {
            await couple_service_1.coupleService.setupProfile(userId, coupleId, data);
        }
        else {
            console.log(`[CoupleController] completeOnboarding: no profile names in payload — skipping setupProfile (reinstall scenario)`);
        }
        // 2. Parallelize photo and answer saves (both are idempotent / additive).
        const tasks = [];
        if (data.primaryPhotoBase64 || (data.secondaryPhotosBase64 && data.secondaryPhotosBase64.length > 0)) {
            tasks.push(couple_service_1.coupleService.uploadPhotos(coupleId, data));
        }
        if (data.answers && data.answers.length > 0) {
            tasks.push(couple_service_1.coupleService.submitAnswers(coupleId, data.answers));
        }
        if (tasks.length > 0)
            await Promise.all(tasks);
        // 3. Always mark the profile as complete — this is the authoritative step.
        await prisma_1.prisma.couple.update({
            where: { coupleId: coupleId },
            data: { isProfileComplete: true },
        });
        await (0, cache_1.invalidateCoupleProfile)(coupleId);
        // 4. Fetch the final profile to return to the client.
        const couple = await couple_service_1.coupleService.getCouple(coupleId);
        console.log(`[CoupleController] completeOnboarding SUCCESS for coupleId: ${coupleId}`);
        (0, response_1.sendSuccess)({
            res,
            statusCode: 200,
            message: 'All Onboarding data completed successfully',
            data: { couple }
        });
    }
    catch (err) {
        console.error(`[CoupleController] completeOnboarding FAILED:`, err);
        throw err;
    }
};
exports.completeOnboarding = completeOnboarding;
const createCouple = async (_req, _res) => {
    // Stub for legacy API
};
exports.createCouple = createCouple;
const getMyCouple = async (req, res) => {
    const { coupleId, userId } = req.user;
    // Serve from cache when available (invalidated by updateMyCouple, uploadPhotos, etc.)
    const cached = await (0, cache_1.getCachedCoupleProfile)(coupleId);
    if (cached) {
        (0, response_1.sendSuccess)({ res, data: { couple: cached, userId } });
        return;
    }
    const couple = await couple_service_1.coupleService.getCouple(coupleId);
    if (!couple) {
        throw new AppError_1.AppError('Couple profile not found', 404);
    }
    // Populate cache for subsequent calls within the TTL.
    await (0, cache_1.setCachedCoupleProfile)(coupleId, couple);
    (0, response_1.sendSuccess)({ res, data: { couple, userId } });
};
exports.getMyCouple = getMyCouple;
const updateMyCouple = async (req, res) => {
    const { coupleId, userId } = req.user;
    const data = req.body;
    const couple = await couple_service_1.coupleService.updateProfile(coupleId, data, userId);
    // Update cache immediately so next GET returns fresh data.
    if (couple)
        await (0, cache_1.setCachedCoupleProfile)(coupleId, couple);
    else
        await (0, cache_1.invalidateCoupleProfile)(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Profile updated successfully', data: { couple } });
};
exports.updateMyCouple = updateMyCouple;
const invitePartner = async (_req, _res) => {
    // Stub for partner invite features (if needed later)
};
exports.invitePartner = invitePartner;
/**
 * POST /api/v1/couples/subscribe
 *
 * LEGACY endpoint. It only flips the cosmetic `Couple.isSubscribed` flag used by
 * the pre-paywall "activate free access" flow while SUBSCRIPTIONS_ENFORCED is
 * off. It grants NO paid entitlement: real feature gating reads the verified
 * `Subscription` table (populated only via App Store / Play receipt
 * verification at /subscriptions/apple|google/verify), never this flag.
 *
 * Once real enforcement is enabled, this self-serve path is disabled so it can
 * never set a stale/unverified flag — clients must go through IAP verification.
 */
const subscribe = async (req, res) => {
    if ((0, subscription_1.isEnforced)()) {
        throw new AppError_1.AppError('This endpoint is no longer available. Purchase Sawa Prime through the app.', 410);
    }
    const { coupleId } = req.user;
    const couple = await couple_service_1.coupleService.subscribe(coupleId);
    (0, response_1.sendSuccess)({
        res,
        statusCode: 200,
        message: 'Subscription activated. First month is on us!',
        data: { couple },
    });
};
exports.subscribe = subscribe;
const getCoupleById = async (req, res) => {
    const { id } = req.params;
    // Use lightweight summary — public profile view doesn't need communityMembers or answers
    const couple = await couple_service_1.coupleService.getCoupleSummary(id);
    if (!couple) {
        throw new AppError_1.AppError('Couple profile not found', 404);
    }
    (0, response_1.sendSuccess)({ res, data: { couple } });
};
exports.getCoupleById = getCoupleById;
const deleteMyAccount = async (req, res) => {
    const { coupleId } = req.user;
    await couple_service_1.coupleService.deleteMyCouple(coupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Account deleted successfully' });
};
exports.deleteMyAccount = deleteMyAccount;
const getBlockList = async (req, res) => {
    const { coupleMongoId } = req.user;
    const blocked = await couple_service_1.coupleService.getBlockedCouples(coupleMongoId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, data: { blocked } });
};
exports.getBlockList = getBlockList;
const blockCouple = async (req, res) => {
    const { coupleMongoId } = req.user;
    const { targetCoupleId } = req.body; // target couple's MONGO _id
    await couple_service_1.coupleService.blockCouple(coupleMongoId, targetCoupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Couple blocked' });
};
exports.blockCouple = blockCouple;
const unblockCouple = async (req, res) => {
    const { coupleMongoId } = req.user;
    const { targetCoupleId } = req.body; // target couple's MONGO _id
    await couple_service_1.coupleService.unblockCouple(coupleMongoId, targetCoupleId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Couple unblocked' });
};
exports.unblockCouple = unblockCouple;
const getBlockedCommunities = async (req, res) => {
    const { coupleMongoId } = req.user;
    const communities = await couple_service_1.coupleService.getBlockedCommunities(coupleMongoId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, data: { communities } });
};
exports.getBlockedCommunities = getBlockedCommunities;
const unblockCommunity = async (req, res) => {
    const { coupleMongoId } = req.user;
    const { communityId } = req.body;
    await couple_service_1.coupleService.unblockCommunity(coupleMongoId, communityId);
    (0, response_1.sendSuccess)({ res, statusCode: 200, message: 'Community unblocked' });
};
exports.unblockCommunity = unblockCommunity;
//# sourceMappingURL=couple.controller.js.map
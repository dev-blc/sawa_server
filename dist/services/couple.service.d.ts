export declare class CoupleService {
    /**
     * Upsert the couple document and update both users' details
     */
    setupProfile(primaryUserId: string, coupleId: string, data: {
        yourName: string;
        yourDob?: string;
        yourEmail?: string;
        partnerName: string;
        partnerDob?: string;
        partnerEmail?: string;
        relationshipStatus?: string;
        location?: {
            city?: string;
            country?: string;
        };
    }): Promise<void>;
    /**
     * Upload photos
     */
    uploadPhotos(coupleId: string, data: {
        primaryPhotoBase64?: string;
        secondaryPhotosBase64?: string[];
        keepSecondaryPhotoUrls?: string[];
    }): Promise<void>;
    /**
     * Submit questionnaire answers and mark onboarding COMPLETE
     */
    submitAnswers(coupleId: string, answers: any[]): Promise<void>;
    updateProfile(coupleId: string, data: {
        bio?: string;
        relationshipStatus?: string;
        preferences?: any;
        yourName?: string;
        yourDob?: string;
        yourEmail?: string;
        partnerName?: string;
        partnerDob?: string;
        partnerEmail?: string;
        primaryPhotoBase64?: string;
        secondaryPhotosBase64?: string[];
        keepSecondaryPhotoUrls?: string[];
        location?: {
            city?: string;
            country?: string;
        };
        locationCity?: string;
        locationCountry?: string;
        locationLatitude?: number;
        locationLongitude?: number;
    }, requestingUserId?: string): Promise<any>;
    private _sanitizePartner;
    private _formatCouple;
    getCouple(coupleId: string): Promise<any | null>;
    getCoupleSummary(coupleId: string): Promise<any | null>;
    subscribe(coupleId: string): Promise<{
        id: string;
        coupleId: string;
        createdAt: Date;
        updatedAt: Date;
        profileName: string | null;
        relationshipStatus: string | null;
        bio: string | null;
        primaryPhoto: string | null;
        secondaryPhotos: string[];
        locationCity: string | null;
        locationCountry: string | null;
        locationLatitude: number | null;
        locationLongitude: number | null;
        isProfileComplete: boolean;
        isSubscribed: boolean;
        isOpenToMeeting: boolean;
        meetingFrequency: string | null;
        socialVibes: string[];
        activities: string[];
        avoidances: string[];
        matchCriteria: string[];
        blocked: string[];
        bannedAt: Date | null;
        banReason: string | null;
        partner1Id: string | null;
        partner2Id: string | null;
    }>;
    blockCouple(meId: string, targetId: string): Promise<{
        id: string;
        coupleId: string;
        blocked: string[];
    } | null>;
    unblockCouple(meId: string, targetId: string): Promise<{
        id: string;
        coupleId: string;
        createdAt: Date;
        updatedAt: Date;
        profileName: string | null;
        relationshipStatus: string | null;
        bio: string | null;
        primaryPhoto: string | null;
        secondaryPhotos: string[];
        locationCity: string | null;
        locationCountry: string | null;
        locationLatitude: number | null;
        locationLongitude: number | null;
        isProfileComplete: boolean;
        isSubscribed: boolean;
        isOpenToMeeting: boolean;
        meetingFrequency: string | null;
        socialVibes: string[];
        activities: string[];
        avoidances: string[];
        matchCriteria: string[];
        blocked: string[];
        bannedAt: Date | null;
        banReason: string | null;
        partner1Id: string | null;
        partner2Id: string | null;
    } | null>;
    getBlockedCouples(meId: string): Promise<{
        id: string;
        coupleId: string;
        profileName: string | null;
        primaryPhoto: string | null;
        locationCity: string | null;
    }[]>;
    getBlockedCommunities(meId: string): Promise<{
        id: any;
        name: any;
        image: any;
    }[]>;
    unblockCommunity(meId: string, communityId: string): Promise<{
        id: string;
        coupleId: string;
        createdAt: Date;
        updatedAt: Date;
        profileName: string | null;
        relationshipStatus: string | null;
        bio: string | null;
        primaryPhoto: string | null;
        secondaryPhotos: string[];
        locationCity: string | null;
        locationCountry: string | null;
        locationLatitude: number | null;
        locationLongitude: number | null;
        isProfileComplete: boolean;
        isSubscribed: boolean;
        isOpenToMeeting: boolean;
        meetingFrequency: string | null;
        socialVibes: string[];
        activities: string[];
        avoidances: string[];
        matchCriteria: string[];
        blocked: string[];
        bannedAt: Date | null;
        banReason: string | null;
        partner1Id: string | null;
        partner2Id: string | null;
    }>;
    /**
     * Fan out a "new couple in your area" notification to all profile-complete,
     * non-banned couples in the same city. This delivers as both an in-app
     * notification (Socket.IO + Notification row) and an OS push (FCM).
     *
     * "Nearby" is currently city-level since we don't store GPS coordinates;
     * upgrade to lat/lng + radius when geolocation is added to the schema.
     */
    private notifyNearbyCouples;
    deleteMyCouple(coupleId: string): Promise<{
        success: boolean;
    }>;
}
export declare const coupleService: CoupleService;
//# sourceMappingURL=couple.service.d.ts.map
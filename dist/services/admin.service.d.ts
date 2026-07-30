export declare class AdminService {
    getStats(): Promise<{
        totalUsers: number;
        totalCouples: number;
        totalCommunities: number;
        totalPrompts: number;
        activeToday: number;
        pendingReports: number;
        bannedCouples: number;
    }>;
    getUsers(token?: string): Promise<{
        _id: string;
        id: string;
        name: string;
        phone: string | null;
        city: string;
        status: "active" | "banned" | "inactive";
        joinedAt: Date;
        lastActiveAt: Date | null;
        coupleId: string | null;
        bannedAt: Date | null;
        banReason: string | null;
        relationshipStatus: string | null;
        profile: {
            bio: string | null;
            primaryPhoto: string | null;
            relationshipStatus: string | null;
            answers: {
                question: string;
                options: string[];
            }[];
        } | null;
    }[]>;
    getCouples(token?: string): Promise<{
        _id: string;
        id: string;
        pairName: string;
        city: string;
        compatibilityScore: number;
        streakDays: number;
        status: "banned" | "inactive" | "engaged" | "new";
        relationshipStatus: string | null;
        bannedAt: Date | null;
        banReason: string | null;
        bio: string | null;
        primaryPhoto: string | null;
        partners: ({
            id: string;
            name: string | null;
            phone: string | null;
            lastActiveAt: Date | null;
        } | null)[];
        answers: {
            question: string;
            options: string[];
        }[];
    }[]>;
    /** Fetch the raw stored image (base64 data URL or http URL) for lazy serving. */
    getRawImage(kind: 'couple' | 'community', id: string): Promise<string | null>;
    getCityDistribution(): Promise<{
        city: string;
        users: number;
        couples: number;
    }[]>;
    deleteCouple(coupleId: string): Promise<void>;
    getCommunities(token?: string): Promise<{
        _id: string;
        id: string;
        name: string;
        description: string | null;
        city: string;
        coverImageUrl: string | null;
        tags: string[];
        category: string;
        memberCount: number;
        members: {
            id: string;
            name: string;
            photo: string | null;
        }[];
        hosts: {
            id: string;
            name: string;
            photo: string | null;
        }[];
        pendingRequests: {
            id: string;
            coupleId: string;
            name: string;
            photo: string | null;
        }[];
        hasNoHost: boolean;
        growthRate: number;
    }[]>;
    getActivities(): Promise<any[]>;
    getPrompts(): Promise<{
        _id: string;
        id: string;
        title: string;
        question: string;
        category: string;
        sortOrder: number;
        tags: never[];
        active: boolean;
        createdAt: Date;
    }[]>;
    getReports(): Promise<{
        _id: any;
        id: any;
        reporter: any;
        target: string;
        reason: any;
        status: any;
        createdAt: any;
    }[]>;
    getBlocks(): Promise<any[]>;
    getChartData(): Promise<{
        name: string;
        users: number;
        couples: number;
        communities: number;
    }[]>;
    getUserLogs(): Promise<{
        id: string;
        title: string;
        actor: string;
        happenedAt: Date;
        type: string;
    }[]>;
    getCommunityLogs(): Promise<{
        id: string;
        title: string;
        actor: string;
        happenedAt: Date;
        type: string;
    }[]>;
    /**
     * Admin community creation. Accepts an optional `hostCoupleId` — if provided,
     * that couple is wired up as both admin and member so they can approve join
     * requests from the mobile app. If omitted, the community has no host and the
     * admin can use `processJoinRequestAsAdmin` to approve requests directly.
     */
    createCommunity(data: {
        name: string;
        description?: string;
        city: string;
        tags?: string[];
        coverImageUrl?: string;
        hostCoupleId?: string | null;
    }): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        city: string;
        coverImageUrl: string | null;
        maxMembers: number;
        tags: string[];
    }>;
    /**
     * Process a community join request from the admin panel.
     * Bypasses the per-couple-admin check used by mobile, so admin-created
     * (host-less) communities can still have requests approved.
     */
    processJoinRequestAsAdmin(communityId: string, requestId: string, decision: 'accept' | 'reject'): Promise<{
        message: string;
    }>;
    /**
     * Ban a couple. Both partners are immediately blocked from logging in or
     * making authenticated requests via existing tokens.
     */
    banCouple(coupleId: string, reason?: string): Promise<{
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
     * Unban a previously-banned couple. They can log in again immediately.
     */
    unbanCouple(coupleId: string): Promise<{
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
    addPrompt(text: string, category: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        text: string;
        category: string;
        isActive: boolean;
        sortOrder: number;
    }>;
    togglePrompt(id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        text: string;
        category: string;
        isActive: boolean;
        sortOrder: number;
    }>;
    editPrompt(id: string, text: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        text: string;
        category: string;
        isActive: boolean;
        sortOrder: number;
    }>;
    reorderPrompts(ids: string[]): Promise<void>;
    deletePrompt(id: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        text: string;
        category: string;
        isActive: boolean;
        sortOrder: number;
    }>;
    sendNotification(title: string, message: string, recipientIds?: string[]): Promise<import(".prisma/client").Prisma.BatchPayload>;
}
//# sourceMappingURL=admin.service.d.ts.map
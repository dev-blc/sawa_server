export declare class OtpService {
    /**
     * Generate a real OTP and send via Twilio SMS.
     * Throws if Twilio is not configured.
     */
    generateAndStore(phone: string, coupleId: string, customMessage?: string, keepValidPrevious?: boolean): Promise<void>;
    /**
     * Verify OTP — strictly checks the stored code. No bypass allowed.
     */
    verify(phone: string, enteredCode: string): Promise<{
        valid: boolean;
        coupleId: string | null;
    }>;
    /**
     * Get coupleId for a phone
     */
    getEntityId(phone: string): Promise<string | null>;
    /**
     * Send SMS invitation via Twilio
     */
    sendInvitation(phone: string, message: string): Promise<boolean>;
}
export declare const otpService: OtpService;
//# sourceMappingURL=otp.service.d.ts.map
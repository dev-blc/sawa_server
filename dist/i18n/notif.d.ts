/**
 * Server-side notification i18n.
 *
 * Every push / in-app notification is defined here as a KEY with translations in
 * all four app languages (en/hi/kn/mr). Feature code calls `renderNotif()` with
 * the recipient's `preferredLocale` to get a localized `{ title, body }`, and
 * attaches `{ i18nKey, i18nParams }` to the notification `data` so the mobile app
 * can ALSO re-render it in the user's currently-selected language (Android
 * notifications and the in-app list are rendered client-side).
 *
 * Gender: `params.g` ('m' | 'f') selects gendered wording where a language needs
 * verb/pronoun agreement. By convention the primary partner is male ('m') and the
 * partner is female ('f') — matching the rest of the app. Never use plural "they"
 * for a single partner.
 */
export type NotifLocale = 'en' | 'hi' | 'kn' | 'mr';
export type NotifGender = 'm' | 'f';
export interface NotifParams {
    name?: string;
    city?: string;
    community?: string;
    actLabel?: string;
    feeling?: string;
    note?: string;
    date?: string;
    girl?: string;
    boy?: string;
    g?: NotifGender;
    [k: string]: string | undefined;
}
/**
 * Render a localized notification. Falls back to English, then to the raw key.
 */
export declare function renderNotif(locale: string | null | undefined, key: string, params?: NotifParams): {
    title: string;
    body: string;
};
/** Serialize params for the FCM `data` payload (all values must be strings). */
export declare function notifDataParams(params?: NotifParams): Record<string, string>;
/** True when we have a template for this key. */
export declare const hasNotifKey: (key: string) => boolean;
/**
 * Build the `data` fields to attach to a notification so both the mobile client
 * (in-app + Android notifee) and the push service can localize it. Spread the
 * result into your notification `data` object.
 */
export declare const i18nData: (key: string, params?: NotifParams) => {
    i18nKey: string;
    i18nParams: NotifParams;
};
//# sourceMappingURL=notif.d.ts.map
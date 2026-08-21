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
  game?: string;
  count?: string;
  years?: string;
  g?: NotifGender;
  [k: string]: string | undefined;
}

/** A translated value: a plain string, or gendered variants keyed by 'm'/'f'. */
type Str = string | { m: string; f: string };

interface Entry {
  title: Record<NotifLocale, Str>;
  body: Record<NotifLocale, Str>;
}

const isLocale = (l: string | null | undefined): l is NotifLocale =>
  l === 'en' || l === 'hi' || l === 'kn' || l === 'mr';

const pick = (v: Str, g: NotifGender): string =>
  typeof v === 'string' ? v : v[g];

const interpolate = (tpl: string, params: NotifParams): string =>
  tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    const val = params[k];
    return val === undefined || val === null ? '' : String(val);
  });

// Mood labels are sent as English keys (e.g. "Happy"). Translate them so the
// server-rendered push body (iOS APNs + Android data) is fully localized, not
// just the surrounding sentence. Mirrors SAWA/src/i18n/locales/*.ts `us.moods`.
const MOODS: Record<string, Record<NotifLocale, string>> = {
  Excited: { en: 'Excited', hi: 'उत्साहित', kn: 'ಉತ್ಸಾಹಿತ', mr: 'उत्साहित' },
  Happy: { en: 'Happy', hi: 'खुश', kn: 'ಸಂತೋಷ', mr: 'आनंदी' },
  Calm: { en: 'Calm', hi: 'शांत', kn: 'ಶಾಂತ', mr: 'शांत' },
  Loved: { en: 'Loved', hi: 'प्यार भरा', kn: 'ಪ್ರೀತಿಯ', mr: 'प्रेमळ' },
  Neutral: { en: 'Neutral', hi: 'सामान्य', kn: 'ಸಾಮಾನ್ಯ', mr: 'सामान्य' },
  Stressed: { en: 'Stressed', hi: 'तनाव में', kn: 'ಒತ್ತಡದಲ್ಲಿ', mr: 'तणावात' },
  Tired: { en: 'Tired', hi: 'थका हुआ', kn: 'ದಣಿದ', mr: 'थकलेले' },
  Sad: { en: 'Sad', hi: 'दुखी', kn: 'ದುಃಖಿತ', mr: 'दुःखी' },
  'Missing You': { en: 'Missing You', hi: 'तुम्हारी कमी', kn: 'ನಿಮ್ಮ ಕೊರತೆ', mr: 'तुझी आठवण' },
  Missing: { en: 'Missing', hi: 'कमी', kn: 'ಕೊರತೆ', mr: 'आठवण' },
  Frustrated: { en: 'Frustrated', hi: 'निराश', kn: 'ಹತಾಶ', mr: 'निराश' },
  Anxious: { en: 'Anxious', hi: 'चिंतित', kn: 'ಆತಂಕ', mr: 'चिंतित' },
  Overwhelmed: { en: 'Overwhelmed', hi: 'अभिभूत', kn: 'ಭಾರವಾದ', mr: 'भारावलेले' },
  Low: { en: 'Low', hi: 'उदास', kn: 'ಖಿನ್ನ', mr: 'उदास' },
};

const localizeMood = (feeling: string | undefined, loc: NotifLocale): string | undefined => {
  if (!feeling) return feeling;
  return MOODS[feeling]?.[loc] ?? feeling;
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const T: Record<string, Entry> = {
  // ── Match / discovery ──────────────────────────────────────────────────────
  'match.pending': {
    title: { en: 'New Connection Request!', hi: 'नया कनेक्शन अनुरोध!', kn: 'ಹೊಸ ಸಂಪರ್ಕ ವಿನಂತಿ!', mr: 'नवीन कनेक्शन विनंती!' },
    body: {
      en: '{name} wants to connect with you!',
      hi: '{name} आपसे जुड़ना चाहते हैं!',
      kn: '{name} ನಿಮ್ಮೊಂದಿಗೆ ಸಂಪರ್ಕ ಸಾಧಿಸಲು ಬಯಸುತ್ತಾರೆ!',
      mr: '{name} तुमच्याशी कनेक्ट होऊ इच्छितात!',
    },
  },
  'match.connected': {
    title: { en: "You've Connected!", hi: 'आप जुड़ गए!', kn: 'ನೀವು ಸಂಪರ್ಕ ಸಾಧಿಸಿದ್ದೀರಿ!', mr: 'तुम्ही कनेक्ट झालात!' },
    body: {
      en: 'You connected with {name}!',
      hi: 'आप {name} से जुड़ गए!',
      kn: 'ನೀವು {name} ಜೊತೆ ಸಂಪರ್ಕ ಸಾಧಿಸಿದ್ದೀರಿ!',
      mr: 'तुम्ही {name} शी कनेक्ट झालात!',
    },
  },
  'match.rejected': {
    title: { en: 'Connection Update', hi: 'कनेक्शन अपडेट', kn: 'ಸಂಪರ್ಕ ನವೀಕರಣ', mr: 'कनेक्शन अपडेट' },
    body: {
      en: 'A couple decided not to connect at this time.',
      hi: 'एक जोड़े ने इस समय न जुड़ने का फैसला किया।',
      kn: 'ಒಂದು ಜೋಡಿ ಈ ಸಮಯದಲ್ಲಿ ಸಂಪರ್ಕ ಸಾಧಿಸದಿರಲು ನಿರ್ಧರಿಸಿದೆ.',
      mr: 'एका जोडप्याने यावेळी कनेक्ट न होण्याचे ठरवले.',
    },
  },
  'nearby.joined': {
    title: { en: 'A new couple joined nearby', hi: 'पास में एक नया जोड़ा शामिल हुआ', kn: 'ಹತ್ತಿರದಲ್ಲಿ ಹೊಸ ಜೋಡಿ ಸೇರಿದೆ', mr: 'जवळपास एक नवीन जोडपे सामील झाले' },
    body: {
      en: '{name} just joined SAWA in {city}. Say hi!',
      hi: '{name} अभी {city} में SAWA से जुड़े। नमस्ते कहें!',
      kn: '{name} ಇದೀಗ {city} ನಲ್ಲಿ SAWA ಸೇರಿದ್ದಾರೆ. ಹಾಯ್ ಹೇಳಿ!',
      mr: '{name} आत्ताच {city} मध्ये SAWA ला सामील झाले. हाय म्हणा!',
    },
  },

  // ── Chat ───────────────────────────────────────────────────────────────────
  'chat.private': {
    title: { en: 'New message from {name}', hi: '{name} का नया संदेश', kn: '{name} ಇಂದ ಹೊಸ ಸಂದೇಶ', mr: '{name} कडून नवीन संदेश' },
    body: {
      en: 'You have new messages from {name}',
      hi: 'आपके पास {name} के नए संदेश हैं',
      kn: 'ನಿಮಗೆ {name} ಇಂದ ಹೊಸ ಸಂದೇಶಗಳಿವೆ',
      mr: 'तुम्हाला {name} कडून नवीन संदेश आहेत',
    },
  },
  'chat.group': {
    title: { en: 'New in {community}', hi: '{community} में नया', kn: '{community} ನಲ್ಲಿ ಹೊಸದು', mr: '{community} मध्ये नवीन' },
    body: {
      en: 'New message in the group',
      hi: 'ग्रुप में नया संदेश',
      kn: 'ಗುಂಪಿನಲ್ಲಿ ಹೊಸ ಸಂದೇಶ',
      mr: 'ग्रुपमध्ये नवीन संदेश',
    },
  },

  // ── Community ────────────────────────────────────────────────────────────────
  'community.invite': {
    title: { en: 'Group Invitation', hi: 'ग्रुप निमंत्रण', kn: 'ಗುಂಪು ಆಹ್ವಾನ', mr: 'ग्रुप निमंत्रण' },
    body: {
      en: '{name} invited you to join {community}',
      hi: '{name} ने आपको {community} में शामिल होने के लिए आमंत्रित किया',
      kn: '{name} ನಿಮ್ಮನ್ನು {community} ಸೇರಲು ಆಹ್ವಾನಿಸಿದ್ದಾರೆ',
      mr: '{name} ने तुम्हाला {community} मध्ये सामील होण्यासाठी आमंत्रित केले',
    },
  },
  'community.joinRequest': {
    title: { en: 'New Join Request', hi: 'नया शामिल होने का अनुरोध', kn: 'ಹೊಸ ಸೇರುವ ವಿನಂತಿ', mr: 'नवीन सामील होण्याची विनंती' },
    body: {
      en: '{name} wants to join.',
      hi: '{name} शामिल होना चाहते हैं।',
      kn: '{name} ಸೇರಲು ಬಯಸುತ್ತಾರೆ.',
      mr: '{name} सामील होऊ इच्छितात.',
    },
  },
  'community.promotedHost': {
    title: {
      en: "You're now the host",
      hi: 'अब आप होस्ट हैं',
      kn: 'ಈಗ ನೀವು ಹೋಸ್ಟ್',
      mr: 'आता तुम्ही होस्ट आहात',
    },
    body: {
      en: 'You\'re now hosting "{community}" on Sawa.',
      hi: 'अब आप Sawa पर "{community}" होस्ट कर रहे हैं।',
      kn: 'ಈಗ ನೀವು Sawa ನಲ್ಲಿ "{community}" ಹೋಸ್ಟ್ ಮಾಡುತ್ತಿದ್ದೀರಿ.',
      mr: 'आता तुम्ही Sawa वर "{community}" होस्ट करत आहात.',
    },
  },
  'community.requestAccepted': {
    title: { en: 'Request Accepted!', hi: 'अनुरोध स्वीकृत!', kn: 'ವಿನಂತಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ!', mr: 'विनंती स्वीकारली!' },
    body: {
      en: 'You joined the group!',
      hi: 'आप ग्रुप में शामिल हो गए!',
      kn: 'ನೀವು ಗುಂಪಿಗೆ ಸೇರಿದ್ದೀರಿ!',
      mr: 'तुम्ही ग्रुपमध्ये सामील झालात!',
    },
  },

  // ── Us space: ask / fridge / cycle ──────────────────────────────────────────
  'us.askFeeling': {
    title: {
      en: '{name} is asking how you feel',
      hi: '{name} पूछ रहे हैं कि आप कैसा महसूस कर रहे हैं',
      kn: 'ನೀವು ಹೇಗಿದ್ದೀರಿ ಎಂದು {name} ಕೇಳುತ್ತಿದ್ದಾರೆ',
      mr: 'तुम्हाला कसे वाटते हे {name} विचारत आहेत',
    },
    body: {
      en: 'Let {name} know how your day is going',
      hi: '{name} को बताएं कि आपका दिन कैसा जा रहा है',
      kn: 'ನಿಮ್ಮ ದಿನ ಹೇಗೆ ಸಾಗುತ್ತಿದೆ ಎಂದು {name} ಗೆ ತಿಳಿಸಿ',
      mr: 'तुमचा दिवस कसा चालला आहे ते {name} ला कळवा',
    },
  },
  'us.fridgeNote': {
    title: {
      en: '{name} left a note on the fridge',
      hi: '{name} ने फ्रिज पर एक नोट छोड़ा',
      kn: '{name} ಫ್ರಿಜ್‌ನಲ್ಲಿ ಒಂದು ಟಿಪ್ಪಣಿ ಬಿಟ್ಟಿದ್ದಾರೆ',
      mr: '{name} ने फ्रिजवर एक नोट ठेवली',
    },
    body: { en: '{note}', hi: '{note}', kn: '{note}', mr: '{note}' },
  },
  'us.fridgeAck': {
    title: {
      en: '{name} acknowledged your note',
      hi: '{name} ने आपका नोट देख लिया',
      kn: '{name} ನಿಮ್ಮ ಟಿಪ್ಪಣಿಯನ್ನು ನೋಡಿದ್ದಾರೆ',
      mr: '{name} ने तुमची नोट पाहिली',
    },
    body: { en: '{note}', hi: '{note}', kn: '{note}', mr: '{note}' },
  },
  'us.cycleShared': {
    title: {
      en: '{name} shared her cycle calendar',
      hi: '{name} ने अपना साइकिल कैलेंडर साझा किया',
      kn: '{name} ತಮ್ಮ ಸೈಕಲ್ ಕ್ಯಾಲೆಂಡರ್ ಹಂಚಿಕೊಂಡಿದ್ದಾರೆ',
      mr: '{name} ने त्यांचे सायकल कॅलेंडर शेअर केले',
    },
    body: {
      en: 'Tap to see it and be there for her',
      hi: 'देखने के लिए टैप करें और उसका साथ दें',
      kn: 'ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ ಮತ್ತು ಅವಳ ಜೊತೆಗಿರಿ',
      mr: 'पाहण्यासाठी टॅप करा आणि तिला साथ द्या',
    },
  },

  // ── Us space: nudges ─────────────────────────────────────────────────────────
  'us.nudge.love': {
    title: {
      en: '{name} sent you love ❤️',
      hi: '{name} ने आपको प्यार भेजा ❤️',
      kn: '{name} ನಿಮಗೆ ಪ್ರೀತಿ ಕಳುಹಿಸಿದ್ದಾರೆ ❤️',
      mr: '{name} ने तुम्हाला प्रेम पाठवले ❤️',
    },
    body: {
      en: 'Thinking of you 💛',
      hi: 'आपको याद कर रहे हैं 💛',
      kn: 'ನಿಮ್ಮನ್ನು ನೆನೆಯುತ್ತಿದ್ದಾರೆ 💛',
      mr: 'तुमची आठवण येत आहे 💛',
    },
  },
  'us.nudge.hug': {
    title: {
      en: '{name} sent you a hug 🤗',
      hi: '{name} ने आपको गले लगाया 🤗',
      kn: '{name} ನಿಮಗೆ ಅಪ್ಪುಗೆ ಕಳುಹಿಸಿದ್ದಾರೆ 🤗',
      mr: '{name} ने तुम्हाला मिठी पाठवली 🤗',
    },
    body: {
      en: 'Warm hug heading your way',
      hi: 'एक गर्मजोशी भरा आलिंगन आपकी ओर',
      kn: 'ಒಂದು ಬೆಚ್ಚಗಿನ ಅಪ್ಪುಗೆ ನಿಮ್ಮ ಕಡೆಗೆ',
      mr: 'एक उबदार मिठी तुमच्याकडे',
    },
  },
  'us.nudge.kiss': {
    title: {
      en: '{name} sent you a kiss 💋',
      hi: '{name} ने आपको एक चुंबन भेजा 💋',
      kn: '{name} ನಿಮಗೆ ಮುತ್ತು ಕಳುಹಿಸಿದ್ದಾರೆ 💋',
      mr: '{name} ने तुम्हाला एक चुंबन पाठवले 💋',
    },
    body: {
      en: 'A sweet kiss from your partner',
      hi: 'आपके साथी की ओर से एक प्यारा चुंबन',
      kn: 'ನಿಮ್ಮ ಸಂಗಾತಿಯಿಂದ ಒಂದು ಸಿಹಿ ಮುತ್ತು',
      mr: 'तुमच्या जोडीदाराकडून एक गोड चुंबन',
    },
  },
  'us.nudge.thinking': {
    title: {
      en: '{name} is thinking of you',
      hi: '{name} आपको याद कर रहे हैं',
      kn: '{name} ನಿಮ್ಮನ್ನು ನೆನೆಯುತ್ತಿದ್ದಾರೆ',
      mr: '{name} तुमची आठवण काढत आहेत',
    },
    body: {
      en: { m: 'You crossed his mind right now', f: 'You crossed her mind right now' },
      hi: 'अभी उनके मन में आप ही हैं',
      kn: 'ಈಗ ಅವರ ಮನಸ್ಸಿನಲ್ಲಿ ನೀವಿದ್ದೀರಿ',
      mr: 'आत्ता त्यांच्या मनात तुम्हीच आहात',
    },
  },
  'us.nudge.missyou': {
    title: {
      en: '{name} misses you',
      hi: '{name} आपको मिस कर रहे हैं',
      kn: '{name} ನಿಮ್ಮನ್ನು ಮಿಸ್ ಮಾಡುತ್ತಿದ್ದಾರೆ',
      mr: '{name} तुम्हाला मिस करत आहेत',
    },
    body: {
      en: { m: 'He wishes you were here', f: 'She wishes you were here' },
      hi: 'काश आप यहाँ होते',
      kn: 'ನೀವು ಇಲ್ಲಿ ಇರಬೇಕೆಂದು ಬಯಸುತ್ತಾರೆ',
      mr: 'तुम्ही इथे असावे असे त्यांना वाटते',
    },
  },
  'us.nudge.cheerup': {
    title: {
      en: '{name} is cheering you up',
      hi: '{name} आपका हौसला बढ़ा रहे हैं',
      kn: '{name} ನಿಮ್ಮನ್ನು ಹುರಿದುಂಬಿಸುತ್ತಿದ್ದಾರೆ',
      mr: '{name} तुम्हाला प्रोत्साहन देत आहेत',
    },
    body: {
      en: 'A little boost from your partner',
      hi: 'आपके साथी की ओर से थोड़ा हौसला',
      kn: 'ನಿಮ್ಮ ಸಂಗಾತಿಯಿಂದ ಸ್ವಲ್ಪ ಪ್ರೋತ್ಸಾಹ',
      mr: 'तुमच्या जोडीदाराकडून थोडे प्रोत्साहन',
    },
  },
  'us.nudge.here': {
    title: {
      en: '{name} is here for you',
      hi: '{name} आपके साथ हैं',
      kn: '{name} ನಿಮ್ಮ ಜೊತೆಗಿದ್ದಾರೆ',
      mr: '{name} तुमच्यासोबत आहेत',
    },
    body: {
      en: { m: 'You have his full support', f: 'You have her full support' },
      hi: 'उनका पूरा साथ आपके साथ है',
      kn: 'ಅವರ ಸಂಪೂರ್ಣ ಬೆಂಬಲ ನಿಮಗಿದೆ',
      mr: 'त्यांचा पूर्ण पाठिंबा तुम्हाला आहे',
    },
  },
  'us.nudge.appreciate': {
    title: {
      en: '{name} appreciates you',
      hi: '{name} आपकी सराहना करते हैं',
      kn: '{name} ನಿಮ್ಮನ್ನು ಮೆಚ್ಚುತ್ತಾರೆ',
      mr: '{name} तुमचे कौतुक करतात',
    },
    body: {
      en: { m: "He's grateful to have you", f: "She's grateful to have you" },
      hi: 'आपको पाकर वे आभारी हैं',
      kn: 'ನಿಮ್ಮನ್ನು ಪಡೆದಿದ್ದಕ್ಕೆ ಅವರು ಕೃತಜ್ಞರಾಗಿದ್ದಾರೆ',
      mr: 'तुम्ही मिळाल्याबद्दल ते कृतज्ञ आहेत',
    },
  },
  'us.nudge.generic': {
    title: {
      en: '{name} sent you a nudge 💛',
      hi: '{name} ने आपको एक नज़ भेजा 💛',
      kn: '{name} ನಿಮಗೆ ಒಂದು ನಡ್ಜ್ ಕಳುಹಿಸಿದ್ದಾರೆ 💛',
      mr: '{name} ने तुम्हाला एक नज पाठवली 💛',
    },
    body: {
      en: 'Tap to see it',
      hi: 'देखने के लिए टैप करें',
      kn: 'ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
      mr: 'पाहण्यासाठी टॅप करा',
    },
  },

  // ── Us space: dates ──────────────────────────────────────────────────────────
  'us.date.request': {
    title: {
      en: '{name} wants to plan {actLabel} 📅',
      hi: '{name} {actLabel} की योजना बनाना चाहते हैं 📅',
      kn: '{name} {actLabel} ಯೋಜಿಸಲು ಬಯಸುತ್ತಾರೆ 📅',
      mr: '{name} {actLabel} ची योजना करू इच्छितात 📅',
    },
    body: {
      en: 'Tap to see the date request',
      hi: 'डेट अनुरोध देखने के लिए टैप करें',
      kn: 'ಡೇಟ್ ವಿನಂತಿ ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
      mr: 'डेट विनंती पाहण्यासाठी टॅप करा',
    },
  },
  'us.date.accept': {
    title: {
      en: '{name} confirmed the date! 🎉',
      hi: '{name} ने डेट की पुष्टि की! 🎉',
      kn: '{name} ಡೇಟ್ ದೃಢಪಡಿಸಿದ್ದಾರೆ! 🎉',
      mr: '{name} ने डेट निश्चित केली! 🎉',
    },
    body: {
      en: "It's on the calendar 🗓️",
      hi: 'यह कैलेंडर पर है 🗓️',
      kn: 'ಇದು ಕ್ಯಾಲೆಂಡರ್‌ನಲ್ಲಿದೆ 🗓️',
      mr: 'ते कॅलेंडरवर आहे 🗓️',
    },
  },
  'us.date.edit': {
    title: {
      en: '{name} updated {actLabel} ✏️',
      hi: '{name} ने {actLabel} अपडेट किया ✏️',
      kn: '{name} {actLabel} ನವೀಕರಿಸಿದ್ದಾರೆ ✏️',
      mr: '{name} ने {actLabel} अपडेट केले ✏️',
    },
    body: {
      en: 'Tap to see the update',
      hi: 'अपडेट देखने के लिए टैप करें',
      kn: 'ನವೀಕರಣ ನೋಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
      mr: 'अपडेट पाहण्यासाठी टॅप करा',
    },
  },
  'us.date.reject': {
    title: {
      en: "{name} couldn't make it this time",
      hi: '{name} इस बार नहीं आ सके',
      kn: '{name} ಈ ಬಾರಿ ಬರಲಾಗಲಿಲ್ಲ',
      mr: '{name} यावेळी येऊ शकले नाहीत',
    },
    body: {
      en: 'Maybe next time 🙏',
      hi: 'शायद अगली बार 🙏',
      kn: 'ಬಹುಶಃ ಮುಂದಿನ ಬಾರಿ 🙏',
      mr: 'कदाचित पुढच्या वेळी 🙏',
    },
  },
  // Sent to BOTH partners the day before a confirmed date on the shared calendar.
  // {timeText} is a pre-built clause (" · 7:00 PM") or empty — kept locale-neutral.
  'us.date.reminder': {
    title: {
      en: '📅 You both have a date tomorrow',
      hi: '📅 कल आप दोनों की एक डेट है',
      kn: '📅 ನಾಳೆ ನಿಮ್ಮಿಬ್ಬರಿಗೆ ಒಂದು ಡೇಟ್ ಇದೆ',
      mr: '📅 उद्या तुम्हा दोघांची एक डेट आहे',
    },
    body: {
      en: '{activity} is tomorrow{timeText} — get ready together! 💕',
      hi: '{activity} कल है{timeText} — साथ मिलकर तैयार हो जाइए! 💕',
      kn: '{activity} ನಾಳೆ ಇದೆ{timeText} — ಒಟ್ಟಿಗೆ ಸಿದ್ಧರಾಗಿ! 💕',
      mr: '{activity} उद्या आहे{timeText} — एकत्र तयार व्हा! 💕',
    },
  },

  // ── Us space: mood ───────────────────────────────────────────────────────────
  'us.mood': {
    title: {
      en: { m: '{name} shared how he feels', f: '{name} shared how she feels' },
      hi: '{name} ने बताया कि वे कैसा महसूस कर रहे हैं',
      kn: '{name} ತಾವು ಹೇಗಿದ್ದೇವೆ ಎಂದು ಹಂಚಿಕೊಂಡಿದ್ದಾರೆ',
      mr: '{name} ने त्यांना कसे वाटते ते शेअर केले',
    },
    body: {
      en: 'Feeling {feeling}',
      hi: '{feeling} महसूस कर रहे हैं',
      kn: '{feeling} ಅನಿಸುತ್ತಿದೆ',
      mr: '{feeling} वाटत आहे',
    },
  },

  // ── Us space: game ───────────────────────────────────────────────────────────
  'us.game.challenge': {
    title: {
      en: '{name} challenged you 🎮',
      hi: '{name} ने आपको चुनौती दी 🎮',
      kn: '{name} ನಿಮಗೆ ಸವಾಲು ಹಾಕಿದ್ದಾರೆ 🎮',
      mr: '{name} ने तुम्हाला आव्हान दिले 🎮',
    },
    body: {
      en: '{game}! Tap to accept and play',
      hi: '{game}! स्वीकार करने और खेलने के लिए टैप करें',
      kn: '{game}! ಸ್ವೀಕರಿಸಲು ಮತ್ತು ಆಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
      mr: '{game}! स्वीकारण्यासाठी आणि खेळण्यासाठी टॅप करा',
    },
  },
  // Sent to the CHALLENGER when the partner accepts while they're offline.
  'us.game.accepted': {
    title: {
      en: '{name} accepted 🎮',
      hi: '{name} ने स्वीकार किया 🎮',
      kn: '{name} ಸ್ವೀಕರಿಸಿದ್ದಾರೆ 🎮',
      mr: '{name} ने स्वीकारले 🎮',
    },
    body: {
      en: 'Your {game} game is on. Tap to play',
      hi: 'आपका {game} शुरू हो गया है। खेलने के लिए टैप करें',
      kn: 'ನಿಮ್ಮ {game} ಆಟ ಶುರುವಾಗಿದೆ. ಆಡಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
      mr: 'तुमचा {game} खेळ सुरू झाला आहे. खेळण्यासाठी टॅप करा',
    },
  },
  // Sent to an OFFLINE partner when a move lands (45s/game throttle).
  'us.game.turn': {
    title: {
      en: 'Your move 🎮',
      hi: 'आपकी चाल 🎮',
      kn: 'ನಿಮ್ಮ ಸರದಿ 🎮',
      mr: 'तुमची खेळी 🎮',
    },
    body: {
      en: '{name} played — your turn at {game}',
      hi: '{name} ने चाल चली — {game} में अब आपकी बारी',
      kn: '{name} ಆಡಿದ್ದಾರೆ — {game} ನಲ್ಲಿ ಈಗ ನಿಮ್ಮ ಸರದಿ',
      mr: '{name} ने खेळी केली — {game} मध्ये आता तुमची पाळी',
    },
  },
  // Game results are written from the RECIPIENT's perspective (the partner who
  // did NOT report the result). In `win` / `winStreak` the recipient won, so
  // {name} is the partner who lost; in `loss` / `lossStreak` {name} is the
  // winner. hi/mr use ergative ("ने") / respectful constructions so no gendered
  // variants are needed; kn uses the genderless respectful plural.
  'us.game.win': {
    title: {
      en: 'You won {game}! 🎉',
      hi: 'आपने {game} जीत लिया! 🎉',
      kn: 'ನೀವು {game} ಗೆದ್ದಿರಿ! 🎉',
      mr: 'तुम्ही {game} जिंकलात! 🎉',
    },
    body: {
      en: 'Nicely played — up for a rematch with {name}?',
      hi: 'बहुत बढ़िया — {name} के साथ एक और मैच?',
      kn: 'ಚೆನ್ನಾಗಿ ಆಡಿದಿರಿ — {name} ಜೊತೆ ಇನ್ನೊಂದು ಆಟ?',
      mr: 'छान खेळलात — {name} सोबत आणखी एक डाव?',
    },
  },
  'us.game.winStreak': {
    title: {
      en: 'You won {game}! 🎉',
      hi: 'आपने {game} जीत लिया! 🎉',
      kn: 'ನೀವು {game} ಗೆದ್ದಿರಿ! 🎉',
      mr: 'तुम्ही {game} जिंकलात! 🎉',
    },
    body: {
      en: "That's {count} in a row for you — give {name} a rematch? 😄",
      hi: 'लगातार {count} जीत आपके नाम — {name} के लिए एक और मैच? 😄',
      kn: 'ಸತತ {count} ಗೆಲುವು ನಿಮ್ಮದು — {name} ಗೆ ಇನ್ನೊಂದು ಅವಕಾಶ? 😄',
      mr: 'सलग {count} वेळा तुमचीच सरशी — {name} ला आणखी एक संधी? 😄',
    },
  },
  'us.game.loss': {
    title: {
      en: '{name} won this round of {game}',
      hi: '{name} ने {game} की यह बाज़ी जीत ली',
      kn: 'ಈ ಸುತ್ತಿನ {game} ಅನ್ನು {name} ಗೆದ್ದರು',
      mr: '{name} ने {game} ची ही फेरी जिंकली',
    },
    body: {
      en: 'Rematch? 😉',
      hi: 'एक और मैच? 😉',
      kn: 'ಇನ್ನೊಂದು ಆಟ? 😉',
      mr: 'आणखी एक डाव? 😉',
    },
  },
  'us.game.lossStreak': {
    title: {
      en: '{name} won this round of {game}',
      hi: '{name} ने {game} की यह बाज़ी जीत ली',
      kn: 'ಈ ಸುತ್ತಿನ {game} ಅನ್ನು {name} ಗೆದ್ದರು',
      mr: '{name} ने {game} ची ही फेरी जिंकली',
    },
    body: {
      en: "That's {count} in a row for {name} — time for a comeback? 😉",
      hi: '{name} की लगातार {count} जीत — अब कमबैक का समय? 😉',
      kn: '{name} ಅವರದ್ದು ಸತತ {count} ಗೆಲುವು — ಈಗ ಕಮ್‌ಬ್ಯಾಕ್ ಸಮಯ? 😉',
      mr: '{name} ने सलग {count} डाव जिंकले — आता कमबॅकची वेळ? 😉',
    },
  },
  'us.game.draw': {
    title: {
      en: "It's a draw at {game} 🤝",
      hi: '{game} में बराबरी 🤝',
      kn: '{game} ಸಮಬಲದಲ್ಲಿ ಮುಗಿಯಿತು 🤝',
      mr: '{game} बरोबरीत सुटला 🤝',
    },
    body: {
      en: 'Evenly matched, you two — rematch?',
      hi: 'आप दोनों बराबर के खिलाड़ी — एक और मैच?',
      kn: 'ನೀವಿಬ್ಬರೂ ಸರಿಸಮ — ಇನ್ನೊಂದು ಆಟ?',
      mr: 'तुम्ही दोघेही तुल्यबळ — आणखी एक डाव?',
    },
  },

  // ── Us space: celebrations (cron) — birthdays & Sawa anniversary ─────────────
  // {name} is always the birthday person; `g` is THEIR gender (en needs it for
  // him/her; hi/kn/mr use respectful genderless forms and stay plain strings).
  'us.birthday.tomorrow': {
    title: {
      en: "🎂 {name}'s birthday is tomorrow",
      hi: '🎂 कल {name} का जन्मदिन है',
      kn: '🎂 ನಾಳೆ {name} ಅವರ ಹುಟ್ಟುಹಬ್ಬ',
      mr: '🎂 उद्या {name} चा वाढदिवस आहे',
    },
    body: {
      en: { m: 'Plan something small and lovely for him', f: 'Plan something small and lovely for her' },
      hi: 'उनके लिए कुछ छोटा-सा और प्यारा प्लान करें',
      kn: 'ಅವರಿಗಾಗಿ ಚಿಕ್ಕದಾದರೂ ಪ್ರೀತಿಯ ಏನಾದರೂ ಯೋಜಿಸಿ',
      mr: 'त्यांच्यासाठी काहीतरी छोटंसं आणि गोड ठरवा',
    },
  },
  'us.birthday.today.you': {
    title: {
      en: '🎂 Happy birthday, {name}!',
      hi: '🎂 जन्मदिन मुबारक, {name}!',
      kn: '🎂 ಹುಟ್ಟುಹಬ್ಬದ ಶುಭಾಶಯಗಳು, {name}!',
      mr: '🎂 वाढदिवसाच्या शुभेच्छा, {name}!',
    },
    body: {
      en: 'Wishing you a day full of little joys 💛',
      hi: 'आपका दिन छोटी-छोटी खुशियों से भरा रहे 💛',
      kn: 'ನಿಮ್ಮ ದಿನ ಸಣ್ಣ ಸಣ್ಣ ಸಂತೋಷಗಳಿಂದ ತುಂಬಿರಲಿ 💛',
      mr: 'तुमचा दिवस छोट्या छोट्या आनंदांनी भरलेला असो 💛',
    },
  },
  'us.birthday.today.partner': {
    title: {
      en: "🎂 It's {name}'s birthday today",
      hi: '🎂 आज {name} का जन्मदिन है',
      kn: '🎂 ಇಂದು {name} ಅವರ ಹುಟ್ಟುಹಬ್ಬ',
      mr: '🎂 आज {name} चा वाढदिवस आहे',
    },
    body: {
      en: { m: 'A little extra love will make his day', f: 'A little extra love will make her day' },
      hi: 'आज थोड़ा और प्यार — उनका दिन बन जाएगा 💛',
      kn: 'ಇಂದು ಸ್ವಲ್ಪ ಹೆಚ್ಚು ಪ್ರೀತಿ ತೋರಿಸಿ — ಅವರ ದಿನ ವಿಶೇಷವಾಗುತ್ತದೆ 💛',
      mr: 'आज थोडं जास्त प्रेम — त्यांचा दिवस खास होईल 💛',
    },
  },
  // Sawa anniversary of Couple.createdAt. Two keys because "1 year" pluralizes
  // differently across the four languages; `many` takes numeric {years} ≥ 2.
  'us.anniversary.one': {
    title: {
      en: '💛 One year of your shared space',
      hi: '💛 आपके साझा स्पेस का एक साल',
      kn: '💛 ನಿಮ್ಮಿಬ್ಬರ ಸಾವಾ ಸ್ಪೇಸ್‌ಗೆ ಒಂದು ವರ್ಷ',
      mr: '💛 तुमच्या शेअर्ड स्पेसचं एक वर्ष',
    },
    body: {
      en: "A year of Sawa together — here's to many more",
      hi: 'सावा पर साथ-साथ एक साल पूरा — यह सिलसिला यूँ ही चले',
      kn: 'ಸಾವಾದಲ್ಲಿ ಜೊತೆಯಾಗಿ ಒಂದು ವರ್ಷ ಪೂರ್ಣ — ಹೀಗೇ ಜೊತೆಗಿರಿ',
      mr: 'सावावर सोबतीचं एक वर्ष पूर्ण — असंच सोबत राहा',
    },
  },
  'us.anniversary.many': {
    title: {
      en: '💛 {years} years of your shared space',
      hi: '💛 आपके साझा स्पेस के {years} साल',
      kn: '💛 ನಿಮ್ಮಿಬ್ಬರ ಸಾವಾ ಸ್ಪೇಸ್‌ಗೆ {years} ವರ್ಷಗಳು',
      mr: '💛 तुमच्या शेअर्ड स्पेसची {years} वर्षं',
    },
    body: {
      en: "{years} years of Sawa together — here's to many more",
      hi: 'सावा पर साथ-साथ {years} साल पूरे — यह सिलसिला यूँ ही चले',
      kn: 'ಸಾವಾದಲ್ಲಿ ಜೊತೆಯಾಗಿ {years} ವರ್ಷಗಳು ಪೂರ್ಣ — ಹೀಗೇ ಜೊತೆಗಿರಿ',
      mr: 'सावावर सोबतीची {years} वर्षं पूर्ण — असंच सोबत राहा',
    },
  },

  // ── Cycle auto-nudges (cron) — recipient is the male partner ({boy}) ─────────
  'cycle.pre_period': {
    title: {
      en: "🌸 {girl}'s period is coming soon",
      hi: '🌸 {girl} का पीरियड जल्द आने वाला है',
      kn: '🌸 {girl} ಅವರ ಮುಟ್ಟು ಶೀಘ್ರದಲ್ಲೇ ಬರಲಿದೆ',
      mr: '🌸 {girl} ची मासिक पाळी लवकरच येणार आहे',
    },
    body: {
      en: 'Hey {boy}, {girl} may get her period in a day or two — be extra gentle and stock up on her favourites 💗',
      hi: 'हे {boy}, {girl} को एक-दो दिन में पीरियड आ सकता है — थोड़ा और कोमल रहें और उसकी पसंदीदा चीज़ें तैयार रखें 💗',
      kn: 'ಹೇ {boy}, {girl} ಗೆ ಒಂದೆರಡು ದಿನಗಳಲ್ಲಿ ಮುಟ್ಟು ಬರಬಹುದು — ಹೆಚ್ಚು ಸೌಮ್ಯವಾಗಿರಿ ಮತ್ತು ಅವಳ ಇಷ್ಟದ ವಸ್ತುಗಳನ್ನು ಸಿದ್ಧವಾಗಿಡಿ 💗',
      mr: 'हे {boy}, {girl} ला एक-दोन दिवसांत मासिक पाळी येऊ शकते — जरा जास्त हळुवार राहा आणि तिच्या आवडत्या गोष्टी तयार ठेवा 💗',
    },
  },
  'cycle.period': {
    title: {
      en: "🌸 {girl}'s period may start today",
      hi: '🌸 {girl} का पीरियड आज शुरू हो सकता है',
      kn: '🌸 {girl} ಅವರ ಮುಟ್ಟು ಇಂದು ಪ್ರಾರಂಭವಾಗಬಹುದು',
      mr: '🌸 {girl} ची मासिक पाळी आज सुरू होऊ शकते',
    },
    body: {
      en: 'Hey {boy}, be extra gentle and caring with her today 💗',
      hi: 'हे {boy}, आज उसके साथ थोड़ा और कोमल और ख्याल रखने वाले बनें 💗',
      kn: 'ಹೇ {boy}, ಇಂದು ಅವಳೊಂದಿಗೆ ಹೆಚ್ಚು ಸೌಮ್ಯವಾಗಿ ಮತ್ತು ಕಾಳಜಿಯಿಂದಿರಿ 💗',
      mr: 'हे {boy}, आज तिच्याशी जरा जास्त हळुवार आणि काळजीने वागा 💗',
    },
  },
  'cycle.fertile': {
    title: {
      en: "💞 {girl}'s fertile window starts today",
      hi: '💞 {girl} की फर्टाइल विंडो आज शुरू होती है',
      kn: '💞 {girl} ಅವರ ಫಲವತ್ತಾದ ಅವಧಿ ಇಂದು ಪ್ರಾರಂಭವಾಗುತ್ತದೆ',
      mr: '💞 {girl} ची फर्टाइल विंडो आज सुरू होते',
    },
    body: {
      en: 'Hey {boy}, a little extra love goes a long way this week',
      hi: 'हे {boy}, इस हफ्ते थोड़ा अतिरिक्त प्यार बहुत काम आता है',
      kn: 'ಹೇ {boy}, ಈ ವಾರ ಸ್ವಲ್ಪ ಹೆಚ್ಚುವರಿ ಪ್ರೀತಿ ಬಹಳ ಸಹಾಯ ಮಾಡುತ್ತದೆ',
      mr: 'हे {boy}, या आठवड्यात थोडे जास्त प्रेम खूप उपयोगी पडते',
    },
  },
  'cycle.ovulation': {
    title: {
      en: '💝 {girl} is in her ovulation period',
      hi: '💝 {girl} अपने ओव्यूलेशन काल में हैं',
      kn: '💝 {girl} ಅವರ ಅಂಡೋತ್ಪತ್ತಿ ಅವಧಿಯಲ್ಲಿದ್ದಾರೆ',
      mr: '💝 {girl} त्यांच्या ओव्ह्युलेशन काळात आहेत',
    },
    body: {
      en: 'Hey {boy}, give her some treats and chocolates to make her feel special!',
      hi: 'हे {boy}, उसे कुछ ट्रीट और चॉकलेट देकर खास महसूस कराएं!',
      kn: 'ಹೇ {boy}, ಅವಳಿಗೆ ಕೆಲವು ಟ್ರೀಟ್‌ಗಳು ಮತ್ತು ಚಾಕೊಲೇಟ್‌ಗಳನ್ನು ನೀಡಿ ವಿಶೇಷವೆನಿಸುವಂತೆ ಮಾಡಿ!',
      mr: 'हे {boy}, तिला काही ट्रीट्स आणि चॉकलेट देऊन खास वाटू द्या!',
    },
  },
  'cycle.pms': {
    title: {
      en: '🫂 {girl} may have mood swings now',
      hi: '🫂 {girl} को अभी मूड स्विंग्स हो सकते हैं',
      kn: '🫂 {girl} ಗೆ ಈಗ ಮೂಡ್ ಸ್ವಿಂಗ್‌ಗಳಾಗಬಹುದು',
      mr: '🫂 {girl} ला आता मूड स्विंग्स होऊ शकतात',
    },
    body: {
      en: 'Hey {boy}, {girl} is in her PMS phase — she might feel moody or extra sensitive. Be patient, compliment her, and surprise her with something she loves 💗',
      hi: 'हे {boy}, {girl} अपने PMS चरण में हैं — वह मूडी या ज़्यादा संवेदनशील महसूस कर सकती हैं। धैर्य रखें, उसकी तारीफ करें और उसकी पसंद की कोई चीज़ देकर सरप्राइज़ करें 💗',
      kn: 'ಹೇ {boy}, {girl} ಅವರ PMS ಹಂತದಲ್ಲಿದ್ದಾರೆ — ಅವಳು ಮೂಡಿ ಅಥವಾ ಹೆಚ್ಚು ಸೂಕ್ಷ್ಮವಾಗಿರಬಹುದು. ತಾಳ್ಮೆಯಿಂದಿರಿ, ಅವಳನ್ನು ಹೊಗಳಿ, ಮತ್ತು ಅವಳ ಇಷ್ಟದ ವಸ್ತುವಿನಿಂದ ಅಚ್ಚರಿಗೊಳಿಸಿ 💗',
      mr: 'हे {boy}, {girl} त्यांच्या PMS टप्प्यात आहेत — त्या चिडचिड्या किंवा जास्त संवेदनशील वाटू शकतात. धीर धरा, तिचे कौतुक करा आणि तिच्या आवडीच्या एखाद्या गोष्टीने सरप्राइज द्या 💗',
    },
  },

  // Neutral push copy for cycle nudges (v3 M5 / India DPDP). The FCM/APNs/Twilio
  // push transits third parties and shows on a lock screen, so it must NOT name
  // the cycle phase or prediction. The real content stays in the in-app
  // Notification row + socket payload (behind auth). Used by cycleNotifier.ts
  // and POST /us/cycle for the OUTBOUND push only.
  'cycle.neutral': {
    title: {
      en: 'A gentle update in your space',
      hi: 'आपके स्पेस में एक कोमल अपडेट',
      kn: 'ನಿಮ್ಮ ಸ್ಪೇಸ್‌ನಲ್ಲಿ ಒಂದು ಸೌಮ್ಯ ಅಪ್‌ಡೇಟ್',
      mr: 'तुमच्या स्पेसमध्ये एक हळुवार अपडेट',
    },
    body: {
      en: 'Open Sawa to see it',
      hi: 'देखने के लिए सावा खोलें',
      kn: 'ನೋಡಲು ಸಾವಾ ತೆರೆಯಿರಿ',
      mr: 'पाहण्यासाठी सावा उघडा',
    },
  },

  // ── Subscriptions ──────────────────────────────────────────────────────────
  'subscription.trialEnding': {
    title: {
      en: '⏳ Your free trial ends tomorrow',
      hi: '⏳ आपका मुफ़्त ट्रायल कल समाप्त हो रहा है',
      kn: '⏳ ನಿಮ್ಮ ಉಚಿತ ಟ್ರಯಲ್ ನಾಳೆ ಮುಗಿಯುತ್ತದೆ',
      mr: '⏳ तुमची मोफत चाचणी उद्या संपत आहे',
    },
    body: {
      en: 'Subscribe to Sawa Prime to keep your connections, groups and chats.',
      hi: 'अपने कनेक्शन, ग्रुप और चैट बनाए रखने के लिए सावा प्राइम सब्सक्राइब करें।',
      kn: 'ನಿಮ್ಮ ಸಂಪರ್ಕಗಳು, ಗುಂಪುಗಳು ಮತ್ತು ಚಾಟ್‌ಗಳನ್ನು ಉಳಿಸಿಕೊಳ್ಳಲು ಸಾವಾ ಪ್ರೈಮ್ ಚಂದಾದಾರರಾಗಿ.',
      mr: 'तुमचे कनेक्शन, गट आणि चॅट टिकवण्यासाठी सावा प्राइम सबस्क्राइब करा.',
    },
  },
  'subscription.trialExpired': {
    title: {
      en: 'Your free trial has ended',
      hi: 'आपका मुफ़्त ट्रायल समाप्त हो गया है',
      kn: 'ನಿಮ್ಮ ಉಚಿತ ಟ್ರಯಲ್ ಮುಗಿದಿದೆ',
      mr: 'तुमची मोफत चाचणी संपली आहे',
    },
    body: {
      en: 'Subscribe to Sawa Prime to continue connecting with couples and groups.',
      hi: 'कपल्स और ग्रुप्स से जुड़ते रहने के लिए सावा प्राइम सब्सक्राइब करें।',
      kn: 'ದಂಪತಿಗಳು ಮತ್ತು ಗುಂಪುಗಳೊಂದಿಗೆ ಸಂಪರ್ಕ ಮುಂದುವರಿಸಲು ಸಾವಾ ಪ್ರೈಮ್ ಚಂದಾದಾರರಾಗಿ.',
      mr: 'जोडपी आणि गटांशी कनेक्ट होत राहण्यासाठी सावा प्राइम सबस्क्राइब करा.',
    },
  },
  'subscription.expired': {
    title: {
      en: 'Your Sawa subscription has expired',
      hi: 'आपकी सावा सदस्यता समाप्त हो गई है',
      kn: 'ನಿಮ್ಮ ಸಾವಾ ಚಂದಾದಾರಿಕೆ ಮುಗಿದಿದೆ',
      mr: 'तुमची सावा सदस्यता संपली आहे',
    },
    body: {
      en: 'Renew to keep your connections, groups and chats active.',
      hi: 'अपने कनेक्शन, ग्रुप और चैट सक्रिय रखने के लिए नवीनीकरण करें।',
      kn: 'ನಿಮ್ಮ ಸಂಪರ್ಕಗಳು, ಗುಂಪುಗಳು ಮತ್ತು ಚಾಟ್‌ಗಳನ್ನು ಸಕ್ರಿಯವಾಗಿರಿಸಲು ನವೀಕರಿಸಿ.',
      mr: 'तुमचे कनेक्शन, गट आणि चॅट सक्रिय ठेवण्यासाठी नूतनीकरण करा.',
    },
  },
};

/**
 * Render a localized notification. Falls back to English, then to the raw key.
 */
export function renderNotif(
  locale: string | null | undefined,
  key: string,
  params: NotifParams = {},
): { title: string; body: string } {
  const loc: NotifLocale = isLocale(locale) ? locale : 'en';
  const entry = T[key];
  if (!entry) return { title: '', body: '' };
  const g: NotifGender = params.g === 'm' ? 'm' : 'f';
  // Localize the mood word itself (e.g. "Happy" → "ಸಂತೋಷ") before interpolation.
  const p: NotifParams = params.feeling
    ? { ...params, feeling: localizeMood(params.feeling, loc) }
    : params;
  const title = interpolate(pick(entry.title[loc] ?? entry.title.en, g), p);
  const body = interpolate(pick(entry.body[loc] ?? entry.body.en, g), p);
  return { title, body };
}

/** Serialize params for the FCM `data` payload (all values must be strings). */
export function notifDataParams(params: NotifParams = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/** True when we have a template for this key. */
export const hasNotifKey = (key: string): boolean => !!T[key];

/**
 * Build the `data` fields to attach to a notification so both the mobile client
 * (in-app + Android notifee) and the push service can localize it. Spread the
 * result into your notification `data` object.
 */
export const i18nData = (
  key: string,
  params: NotifParams = {},
): { i18nKey: string; i18nParams: NotifParams } => ({ i18nKey: key, i18nParams: params });

import OpenAI from 'openai';
import { logger } from './logger';
import { env } from '../config/env';

const client = new OpenAI({
  apiKey: env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const BIO_LINE_COUNT = 12;
const BIO_MAX_WORDS = 140;

/**
 * Generates one shared couple bio ("Who we are") and match criteria.
 * Bio is a single voice for the pair — not two separate partner bios.
 */
export const generateCoupleBio = async (
  qaData: Array<{ question: string; answers: string[] }>,
): Promise<{ bio: string; matchCriteria: string[] }> => {
  try {
    const context = qaData
      .map((item) => `Q: ${item.question}\nA: ${item.answers.join(', ')}`)
      .join('\n\n');

    const response = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You write profiles for SAWA, a couples social app in India.

OUTPUT: Return JSON only with:
1. "bio" — ONE shared story for the couple (first-person plural: we, our, us). NOT two bios. NOT "Partner A / Partner B".
2. "matchCriteria" — ONE short sentence (max 25 words) about what kind of couples they click with.

BIO FORMAT (strict):
- Exactly ${BIO_LINE_COUNT} lines, separated by newline characters \\n in the JSON string.
- Each line is one short, complete thought (about 8–14 words per line).
- Total bio under ${BIO_MAX_WORDS} words.
- Reads like a real couple wrote it in Notes — warm, specific, a little imperfect, never corporate.

VOICE:
- Use details from their answers (food, hosting, trips, pace of life, boundaries).
- Gentle humour is fine. No emojis. No hashtags.
- Never use: journey, passionate, dynamic, foodie, adventure-seekers, partner in crime, love to laugh, vibe, energy, explore, connect, meaningful, authentic (as filler).

GOOD line examples:
"We still argue about who's cooking but everyone leaves full."
"Our flat is loud on Fridays — friends, wine, whatever's on the stove."

BAD (do not write like this):
"We are passionate about building meaningful connections." 
"We love exploring new horizons together."`,
        },
        {
          role: 'user',
          content: `Onboarding answers:\n\n${context}\n\nWrite JSON with "bio" (${BIO_LINE_COUNT} lines with \\n) and "matchCriteria". One couple, one bio.`,
        },
      ],
      temperature: 0.88,
      max_tokens: 520,
      response_format: { type: 'json_object' },
    });

    let content = response.choices[0]?.message?.content || '{}';

    if (content.includes('```')) {
      content = content.replace(/```json|```/g, '').trim();
    }

    const parsed = JSON.parse(content);
    let bio = typeof parsed.bio === 'string' ? parsed.bio.trim() : '';

    // Normalize: ensure line breaks, collapse duplicate newlines, trim each line
    bio = bio
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line: string) => line.trim())
      .filter(Boolean)
      .slice(0, BIO_LINE_COUNT)
      .join('\n');

    logger.info(`[GroqAI] Bio generation successful (${bio.split('\n').length} lines).`);

    return {
      bio,
      matchCriteria: parsed.matchCriteria ? [String(parsed.matchCriteria).trim()] : [],
    };
  } catch (err) {
    logger.error('[GroqAI] Failed to generate structured bio:', err);
    return { bio: '', matchCriteria: [] };
  }
};

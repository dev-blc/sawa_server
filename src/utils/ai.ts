import OpenAI from 'openai';
import { logger } from './logger';
import { env } from '../config/env';

const client = new OpenAI({
  apiKey: env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

/**
 * Generates a couple bio ("Who we are") and match criteria ("What we are looking for")
 * based on onboarding answers.
 */
export const generateCoupleBio = async (
  qaData: Array<{ question: string; answers: string[] }>
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
          content: `You are a creative profile generator for SAWA, a high-end couple's matchmaking app. 

          CRITICAL REQUIREMENT: Every profile MUST be unique and specifically tailored to the nuances of the provided answers. 
          AVOID GENERIC CLICHES like "We are a laid-back couple" or "excited to explore the city".
          Instead, use the specific details from the answers (e.g., if they mention 'career', 'structure', or 'small groups', weave those specific themes into the tone and content).

          Your goal is to write a warm, engaging profile that feels authentic and human.
          
          You must return a JSON object with exactly two fields:
          1. "bio": A warm, sophisticated 1-2 line paragraph about who the couple is. Use "We". Make it sound premium and human-like.
          2. "matchCriteria": A single, elegant paragraph (2-3 sentences) describing the kind of couples they are looking to connect with and the vibes they prefer.

          Examples of SOPHISTICATED styles:
          - "Navigating our corporate careers in the city, we value intentional social circles and structured weekend plans that allow for deep conversation over a great bottle of wine."
          - "As a family-first couple, we're currently in a nesting phase but love hosting low-key gatherings for like-minded friends who appreciate a good home-cooked meal and shared stories."`,
        },
        {
          role: 'user',
          content: `Here are our context-specific answers from onboarding:\n\n${context}\n\nPlease generate a UNIQUE, elegant "bio" and a sophisticated "matchCriteria" paragraph as a JSON object reflecting these specific preferences.`,
        },
      ],
      temperature: 0.8,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    
    return {
      bio: parsed.bio || '',
      matchCriteria: parsed.matchCriteria ? [parsed.matchCriteria] : [],
    };
  } catch (err) {
    logger.error('[GroqAI] Failed to generate structured bio:', err);
    return { bio: '', matchCriteria: [] };
  }
};

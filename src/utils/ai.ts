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
          content: `You are a helpful profile generator for SAWA, a couple's matchmaking app. 
          Your goal is to write a warm, engaging profile for a couple based on their onboarding answers.
          
          You must return a JSON object with two fields:
          1. "bio": A 3-4 line friendly paragraph about who the couple is (use "We").
          2. "matchCriteria": A list of 2-3 short strings describing what they are looking for in other couples.

          Example output:
          {
            "bio": "We are a laid-back couple who loves hiking and trying out new coffee shops. We moved here recently and are excited to explore the city vibe together.",
            "matchCriteria": ["Active couples for weekend hikes", "Foodies for brunch and coffee", "Double dates"]
          }`,
        },
        {
          role: 'user',
          content: `Here are our answers from onboarding:\n\n${context}\n\nPlease generate our "bio" and "matchCriteria" as a JSON object.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    
    return {
      bio: parsed.bio || '',
      matchCriteria: Array.isArray(parsed.matchCriteria) ? parsed.matchCriteria : [],
    };
  } catch (err) {
    logger.error('[GroqAI] Failed to generate structured bio:', err);
    return { bio: '', matchCriteria: [] };
  }
};

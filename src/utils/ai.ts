import OpenAI from 'openai';
import { logger } from './logger';

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

/**
 * Generates a 4-line couple bio based on onboarding answers.
 */
export const generateCoupleBio = async (qaData: Array<{ question: string; answers: string[] }>): Promise<string> => {
  try {
    const context = qaData
      .map((item) => `Q: ${item.question}\nA: ${item.answers.join(', ')}`)
      .join('\n\n');

    const response = await client.chat.completions.create({
      model: 'llama3-8b-8192', // Groq's fast llama model
      messages: [
        {
          role: 'system',
          content: `You are a helpful profile bio generator for SAWA, a couple's matchmaking app. 
          Your goal is to write a warm, engaging, and friendly bio for a couple based on their onboarding answers.
          Keep it exactly 3 to 4 short lines of text. 
          Focus on their lifestyle, relationship vibe, and what they are looking for.
          Write in a friendly, conversational tone (using "We").`,
        },
        {
          role: 'user',
          content: `Here are our answers from onboarding:\n\n${context}\n\nPlease generate a 4-line bio for our profile.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    return response.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    logger.error('[GroqAI] Failed to generate bio:', err);
    return ''; // Fallback to empty string
  }
};

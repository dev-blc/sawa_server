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
          
          You must return a JSON object with two fields:
          1. "bio": A short, 1-2 line unique paragraph about who the couple is. Use "We". STRICTLY MAX 250 characters.
          2. "matchCriteria": A list of 2-3 very short, specific strings (max 40 characters each) describing what they are looking for.

          Examples of DIFFERENT styles (do not copy, just for inspiration):
          - Professional: "Navigating our corporate careers in the city, we value structured weekend plans and intentional social circles..."
          - Weekend Warriors: "You'll usually find us planning our next road trip. We're the 'yes' couple of the group, always down for a spontaneous hike..."
          - Low-key: "Quality over quantity is our mantra. We prefer small, intimate dinners where we can actually have a conversation..."`,
        },
        {
          role: 'user',
          content: `Here are our context-specific answers from onboarding:\n\n${context}\n\nPlease generate a UNIQUE "bio" and "matchCriteria" as a JSON object reflecting these specific preferences.`,
        },
      ],
      temperature: 0.85,
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

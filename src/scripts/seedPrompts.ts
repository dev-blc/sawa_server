import { prisma } from '../lib/prisma';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PROMPTS = [
  "What's your favorite family activity?",
  'Wanna hangout?',
  'Movie this weekend?',
  'Coffee sometime this week?',
  'Any plans for the holidays?',
];

async function seedPrompts() {
  try {
    for (const text of DEFAULT_PROMPTS) {
      const exists = await prisma.prompt.findFirst({ where: { text } });
      if (!exists) {
        await prisma.prompt.create({
            data: { text, category: 'chat_shortcut', isActive: true }
        });
        console.log(`✅ Seeded prompt: ${text}`);
      }
    }
    console.log('🚀 Default prompts restored!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

seedPrompts();

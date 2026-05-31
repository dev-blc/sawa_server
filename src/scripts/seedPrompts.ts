import { prisma } from '../lib/prisma';
import dotenv from 'dotenv';
import { DEFAULT_CHAT_PROMPTS } from '../constants/chatPrompts';

dotenv.config();

async function seedPrompts() {
  try {
    for (const text of DEFAULT_CHAT_PROMPTS) {
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

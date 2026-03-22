import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

const DEFAULT_PROMPTS = [
  "Hello, how are you?",
  "Let's connect!",
  "I'd love to chat more.",
  "Are you free this weekend?",
  "Coffee sometime?"
];

async function seedPrompts() {
  if (!MONGODB_URI) return;
  try {
    await mongoose.connect(MONGODB_URI);
    const Prompt = mongoose.model('Prompt', new mongoose.Schema({
      text: String,
      category: String,
      isActive: { type: Boolean, default: true }
    }));

    for (const text of DEFAULT_PROMPTS) {
      const exists = await Prompt.findOne({ text });
      if (!exists) {
        await new Prompt({ text, category: 'chat_shortcut', isActive: true }).save();
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

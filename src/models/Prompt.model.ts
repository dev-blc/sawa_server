import mongoose, { Schema, Document } from 'mongoose';

export interface IPrompt extends Document {
    text: string;
    category: string; // e.g. 'chat_shortcut', 'daily_topic'
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const PromptSchema = new Schema<IPrompt>(
    {
        text: { type: String, required: true },
        category: { type: String, default: 'chat_shortcut' },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

export const Prompt = mongoose.model<IPrompt>('Prompt', PromptSchema);

import mongoose, { Schema, Document, Types } from 'mongoose';

export type ContentType = 'text' | 'image' | 'gif';
export type ChatType = 'private' | 'group';

export interface IMessage extends Document {
  chatType: ChatType;
  chatId: Types.ObjectId; // matchId (private) or communityId (group)
  sender: Types.ObjectId; // ref: Couple
  senderUser: Types.ObjectId; // ref: User (Individual sender)
  senderName: string; // User's name (X, Y, A, or B)
  content: string;
  contentType: ContentType;
  readBy: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    chatType: {
      type: String,
      enum: ['private', 'group'],
      required: true,
    },
    chatId: { type: Schema.Types.ObjectId, required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    senderUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    contentType: {
      type: String,
      enum: ['text', 'image', 'gif'],
      default: 'text',
    },
    readBy: [{ type: Schema.Types.ObjectId, ref: 'Couple' }],
  },
  { timestamps: true },
);

MessageSchema.index({ chatId: 1, createdAt: -1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

import mongoose, { Schema, Document, Types } from 'mongoose';

export interface INotification extends Document {
  recipient: Types.ObjectId; // The couple who receives the notification
  sender?: Types.ObjectId; // The couple who triggered it (optional)
  type: 'match' | 'message' | 'community' | 'system';
  title: string;
  message: string;
  data?: any; // Extra info (e.g. matchId, communityId)
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.Mixed, ref: 'Couple', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'Couple' },
    type: {
      type: String,
      enum: ['match', 'message', 'community', 'system'],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Performance: Speed up unread count and general notification listing
NotificationSchema.index({ recipient: 1, read: 1 });
NotificationSchema.index({ createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

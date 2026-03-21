import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IMatch extends Document {
  couple1: Types.ObjectId; // The couple initiating/interacting
  couple2: Types.ObjectId; // The target couple
  status: 'pending' | 'accepted' | 'rejected' | 'skipped'; // pending = Hello sent, skipped = user skipped
  actionBy: Types.ObjectId; // Which couple made the last action
  matchScore: number;
  insights: string[]; // e.g. "Both career-focused", "Similar pace"
  createdAt: Date;
  updatedAt: Date;
}

const MatchSchema = new Schema<IMatch>(
  {
    couple1: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    couple2: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'skipped'],
      required: true,
    },
    actionBy: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
    matchScore: { type: Number, default: 0 },
    insights: [{ type: String }],
  },
  { timestamps: true }
);

// Performance: Optimize relationship lookups and status filtering
MatchSchema.index({ couple1: 1, couple2: 1 }, { unique: true });
MatchSchema.index({ couple2: 1, status: 1 });
MatchSchema.index({ status: 1 });

export const Match = mongoose.model<IMatch>('Match', MatchSchema);

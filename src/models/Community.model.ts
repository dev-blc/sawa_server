import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICommunity extends Document {
  name: string;
  description?: string;
  city: string;
  coverImageUrl: string;
  members: Types.ObjectId[]; // ref: Couple
  admins: Types.ObjectId[]; // ref: Couple
  joinRequests: Types.ObjectId[]; // ref: Couple (pending requests)
  maxMembers: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CommunitySchema = new Schema<ICommunity>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    city: { type: String, required: true },
    coverImageUrl: { type: String },
    members: [{ type: Schema.Types.ObjectId, ref: 'Couple' }],
    admins: [{ type: Schema.Types.ObjectId, ref: 'Couple' }],
    joinRequests: [{ type: Schema.Types.ObjectId, ref: 'Couple' }],
    maxMembers: { type: Number, default: 50 },
    tags: [{ type: String }],
  },
  { timestamps: true }
);

export const Community = mongoose.model<ICommunity>('Community', CommunitySchema);

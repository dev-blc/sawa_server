import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IOnboardingAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

export interface ICouple extends Document {
  coupleId: string;    // Matches User.coupleId
  partner1?: Types.ObjectId;
  partner2?: Types.ObjectId;
  profileName?: string;
  relationshipStatus?: string;
  bio?: string;
  primaryPhoto?: string;
  secondaryPhotos: string[];
  location?: {
    city?: string;
    country?: string;
  };
  answers: IOnboardingAnswer[];
  isProfileComplete: boolean;
  isSubscribed: boolean;
  preferences: {
    meetingFrequency?: string; // e.g. 'once-month'
    socialVibes?: string[];
    activities?: string[];
    avoidances?: string[];
    matchCriteria?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const CoupleSchema = new Schema<ICouple>(
  {
    coupleId: { type: String, required: true, unique: true, index: true },
    partner1: { type: Schema.Types.ObjectId, ref: 'User' },
    partner2: { type: Schema.Types.ObjectId, ref: 'User' },
    profileName: { type: String, trim: true },
    relationshipStatus: { type: String },
    bio: { type: String, trim: true, maxlength: 1000 },
    primaryPhoto: { type: String },
    secondaryPhotos: [{ type: String }],
    location: {
      city: { type: String },
      country: { type: String },
    },
    answers: [
      {
        questionId: { type: String, required: true },
        selectedOptionIds: [{ type: String }],
      },
    ],
    isProfileComplete: { type: Boolean, default: false },
    isSubscribed: { type: Boolean, default: false },
    preferences: {
      meetingFrequency: { type: String },
      socialVibes: [{ type: String }],
      activities: [{ type: String }],
      avoidances: [{ type: String }],
      matchCriteria: [{ type: String }],
    },
  },
  { timestamps: true },
);

export const Couple = mongoose.model<ICouple>('Couple', CoupleSchema);

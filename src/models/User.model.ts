import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUser extends Document {
  phone: string;
  name?: string;
  email?: string;
  dob?: string;
  coupleId: string;          // shared couple entity ID
  isPhoneVerified: boolean;
  refreshTokenHash?: string;
  role: 'primary' | 'partner' | 'admin'; // which seat in the couple, or admin
  password?: string; // only for admin users
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    phone: {
      type: String,
      required: function (this: IUser) {
        return this.role !== 'admin';
      },
      unique: true,
      sparse: true,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    dob: {
      type: String,
    },
    coupleId: {
      type: String,
      required: true,
      index: true,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    refreshTokenHash: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      enum: ['primary', 'partner', 'admin'],
      required: true,
    },
    password: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

export const User = mongoose.model<IUser>('User', UserSchema);

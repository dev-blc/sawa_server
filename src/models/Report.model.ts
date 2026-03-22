import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IReport extends Document {
    reporter: Types.ObjectId; // Couple who reported
    target: Types.ObjectId;   // Couple being reported
    reason: string;
    details?: string;
    status: 'pending' | 'reviewed' | 'resolved' | 'dismissed';
    createdAt: Date;
    updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
    {
        reporter: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
        target: { type: Schema.Types.ObjectId, ref: 'Couple', required: true },
        reason: { type: String, required: true },
        details: { type: String },
        status: {
            type: String,
            enum: ['pending', 'reviewed', 'resolved', 'dismissed'],
            default: 'pending',
        },
    },
    { timestamps: true }
);

export const Report = mongoose.model<IReport>('Report', ReportSchema);

// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { OtpToken as PrismaOtpToken } from '@prisma/client';

export type IOtpToken = PrismaOtpToken;

export const OtpToken = prisma.otpToken;

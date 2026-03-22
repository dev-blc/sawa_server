// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Couple as PrismaCouple, OnboardingAnswer as PrismaAnswer } from '@prisma/client';

export type ICouple = PrismaCouple;
export type IOnboardingAnswer = PrismaAnswer;

export const Couple = prisma.couple;

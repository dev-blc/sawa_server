// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Prompt as PrismaPrompt } from '@prisma/client';

export type IPrompt = PrismaPrompt;

export const Prompt = prisma.prompt;

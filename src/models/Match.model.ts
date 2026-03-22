// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Match as PrismaMatch, MatchStatus } from '@prisma/client';

export type IMatch = PrismaMatch;
export type { MatchStatus };

export const Match = prisma.match;

// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Community as PrismaCommunity } from '@prisma/client';

export type ICommunity = PrismaCommunity;

export const Community = prisma.community;

// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Message as PrismaMessage, ChatType, ContentType } from '@prisma/client';

export type IMessage = PrismaMessage;
export type { ChatType, ContentType };

export const Message = prisma.message;

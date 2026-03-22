// Prisma re-export — preserves existing import patterns
// import { User } from '../models/User.model'  ← still works everywhere
import { prisma } from '../lib/prisma';
import type { User as PrismaUser, UserRole } from '@prisma/client';

export type IUser = PrismaUser;
export type { UserRole };

// Export the prisma delegate as a drop-in accessor
export const User = prisma.user;

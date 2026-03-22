// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Notification as PrismaNotification, NotificationType } from '@prisma/client';

export type INotification = PrismaNotification;
export type { NotificationType };

export const Notification = prisma.notification;

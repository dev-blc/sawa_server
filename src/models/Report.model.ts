// Prisma re-export — preserves existing import patterns
import { prisma } from '../lib/prisma';
import type { Report as PrismaReport, ReportStatus } from '@prisma/client';

export type IReport = PrismaReport;
export type { ReportStatus };

export const Report = prisma.report;

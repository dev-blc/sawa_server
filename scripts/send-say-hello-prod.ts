/**
 * Send a "Say Hello" (connection request) on production using the same MatchService
 * logic as POST /api/v1/matches/say-hello on the mobile app.
 *
 * Requires server/.env DATABASE_URL pointing at production Postgres.
 *
 * Usage:
 *   cd server
 *   npx ts-node --transpile-only scripts/send-say-hello-prod.ts --list
 *   npx ts-node --transpile-only scripts/send-say-hello-prod.ts \
 *     --target-name "Kiran" \
 *     --from-name "Rakesh" \
 *     --confirm
 *
 * Options:
 *   --target-name   Substring to find recipient couple (default: Kiran)
 *   --target-id     Recipient coupleId (overrides --target-name)
 *   --from-name     Substring to find sender couple
 *   --from-id       Sender coupleId (overrides --from-name)
 *   --list          List recent couples (no writes)
 *   --confirm       Required to write to the database
 *   --reset         Delete existing pending match between the two before sending
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { matchService } from '../src/services/match.service';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

function maskDbHost(url?: string): string {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname || ''}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const hasFlag = (flag: string) => process.argv.includes(flag);

async function findCouplesByName(substring: string) {
  return prisma.couple.findMany({
    where: {
      profileName: { contains: substring, mode: 'insensitive' },
      isProfileComplete: true,
    },
    select: {
      id: true,
      coupleId: true,
      profileName: true,
      locationCity: true,
      isSubscribed: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
}

async function findCoupleByCoupleId(coupleId: string) {
  return prisma.couple.findUnique({
    where: { coupleId },
    select: {
      id: true,
      coupleId: true,
      profileName: true,
      locationCity: true,
      isSubscribed: true,
    },
  });
}

async function listCouples() {
  const couples = await prisma.couple.findMany({
    where: { isProfileComplete: true, profileName: { not: null } },
    select: {
      coupleId: true,
      profileName: true,
      locationCity: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 40,
  });

  console.log('\n--- Recent complete couples (prod) ---');
  for (const c of couples) {
    console.log(
      `  ${c.coupleId}  |  ${c.profileName ?? '—'}  |  ${c.locationCity ?? '—'}  |  updated ${c.updatedAt.toISOString().slice(0, 10)}`,
    );
  }
  console.log('---\n');
}

async function pickSender(
  targetCoupleId: string,
  fromName?: string,
  fromId?: string,
) {
  if (fromId) {
    const c = await findCoupleByCoupleId(fromId);
    if (!c) throw new Error(`Sender coupleId not found: ${fromId}`);
    if (c.coupleId === targetCoupleId) throw new Error('Sender and target must be different couples');
    return c;
  }

  if (fromName) {
    const matches = await findCouplesByName(fromName);
    const pick = matches.find((c) => c.coupleId !== targetCoupleId);
    if (!pick) {
      throw new Error(`No sender couple matching "${fromName}" (excluding target).`);
    }
    if (matches.length > 1) {
      console.log(`ℹ️  Multiple senders match "${fromName}"; using: ${pick.profileName} (${pick.coupleId})`);
    }
    return pick;
  }

  const fallback = await prisma.couple.findFirst({
    where: {
      isProfileComplete: true,
      coupleId: { not: targetCoupleId },
      profileName: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      coupleId: true,
      profileName: true,
      locationCity: true,
      isSubscribed: true,
    },
  });

  if (!fallback) throw new Error('No fallback sender couple found in prod.');
  console.log(`ℹ️  No --from-* provided; using latest other couple: ${fallback.profileName} (${fallback.coupleId})`);
  return fallback;
}

async function resetExistingPair(senderId: string, targetId: string) {
  const deleted = await prisma.match.deleteMany({
    where: {
      OR: [
        { couple1Id: senderId, couple2Id: targetId },
        { couple1Id: targetId, couple2Id: senderId },
      ],
    },
  });
  const notifs = await prisma.notification.deleteMany({
    where: {
      type: 'match',
      OR: [
        { senderId, recipientId: targetId },
        { senderId: targetId, recipientId: senderId },
      ],
    },
  });
  console.log(`🗑  Removed ${deleted.count} match row(s), ${notifs.count} notification(s) between pair.`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  console.log(`\n📡 Database: ${maskDbHost(dbUrl)}`);

  if (!dbUrl) {
    console.error('❌ DATABASE_URL is missing. Set it in server/.env (production Postgres).');
    process.exit(1);
  }

  if (hasFlag('--list')) {
    await listCouples();
    return;
  }

  const targetName = argValue('--target-name') ?? 'Kiran';
  const targetId = argValue('--target-id');
  const fromName = argValue('--from-name');
  const fromId = argValue('--from-id');
  const confirm = hasFlag('--confirm');
  const reset = hasFlag('--reset');

  let target;
  if (targetId) {
    target = await findCoupleByCoupleId(targetId);
    if (!target) throw new Error(`Target coupleId not found: ${targetId}`);
  } else {
    const matches = await findCouplesByName(targetName);
    if (matches.length === 0) {
      throw new Error(`No couple found matching name "${targetName}". Run with --list.`);
    }
    if (matches.length > 1) {
      console.log(`\n⚠️  Multiple targets match "${targetName}":`);
      matches.forEach((c) =>
        console.log(`   - ${c.profileName} (${c.coupleId})`),
      );
      console.log(`   Using first: ${matches[0].profileName} (${matches[0].coupleId})`);
      console.log('   Pass --target-id <coupleId> to pick a specific couple.\n');
    }
    target = matches[0];
  }

  const sender = await pickSender(target.coupleId, fromName, fromId);

  console.log('\n--- Say Hello (prod) ---');
  console.log(`  From:   ${sender.profileName}  (${sender.coupleId})`);
  console.log(`  To:     ${target.profileName}  (${target.coupleId})`);
  console.log(`  Same as mobile: matchService.sayHello(sender → target)\n`);

  const existing = await prisma.match.findMany({
    where: {
      OR: [
        { couple1Id: sender.coupleId, couple2Id: target.coupleId },
        { couple1Id: target.coupleId, couple2Id: sender.coupleId },
      ],
    },
  });

  if (existing.length) {
    console.log('Existing match rows:');
    existing.forEach((m) =>
      console.log(`  - id=${m.id} status=${m.status} actionById=${m.actionById}`),
    );
  }

  if (!confirm) {
    console.log('\n⏸  Dry run only. Re-run with --confirm to write.');
    console.log('   Add --reset to clear an existing pair first.\n');
    return;
  }

  if (reset && existing.length) {
    await resetExistingPair(sender.coupleId, target.coupleId);
  }

  const result = await matchService.sayHello(sender.coupleId, target.coupleId);

  const notif = await prisma.notification.findFirst({
    where: {
      recipientId: target.coupleId,
      senderId: sender.coupleId,
      type: 'match',
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log('\n✅ sayHello completed');
  console.log('   result:', JSON.stringify(result));
  if (notif) {
    console.log(`   notification id=${notif.id}`);
    console.log(`   title: ${notif.title}`);
    console.log(`   message: ${notif.message}`);
  } else {
    console.log('   (no new notification row — may be mutual accept or duplicate hello)');
  }

  const incoming = await prisma.match.findMany({
    where: {
      status: 'pending',
      couple2Id: target.coupleId,
      actionById: { not: target.coupleId },
    },
    include: {
      couple1: { select: { profileName: true, coupleId: true } },
    },
  });

  console.log(`\n📥 Pending incoming for ${target.profileName}: ${incoming.length}`);
  incoming.forEach((m) => {
    console.log(`   - from ${m.couple1.profileName} (${m.couple1.coupleId}) matchId=${m.id}`);
  });

  console.log('\n👉 On device: open Notifications or Who wants to connect / Chats to verify.\n');
}

main()
  .catch((err) => {
    console.error('\n❌', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

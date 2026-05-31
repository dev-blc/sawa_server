/**
 * One-off: delete requested test accounts (3 couples, 6 users).
 * Run: cd server && npx ts-node scripts/delete-requested-users.ts
 */
import { prisma } from '../src/lib/prisma';
import { coupleService } from '../src/services/couple.service';

const COUPLE_IDS = [
  'eaf74098-5011-47a6-9a9b-36610c95942f', // (no name) x2
  '31aecce3-c0b4-47b7-83c3-894851cf66a9', // Gokul & Priyan
  '23296ba9-db38-4049-bffe-f85ed59df56f', // Kiran & Stella
];

const PHONES = [
  '8956433308',
  '8087999667',
  '6379571297',
  '9360477834',
  '7200665788',
  '6369758396',
];

async function deleteCoupleById(coupleId: string) {
  const couple = await prisma.couple.findUnique({ where: { coupleId } });
  if (!couple) {
    console.log(`⏭  Couple not found (already deleted): ${coupleId}`);
    return;
  }

  const users = await prisma.user.findMany({ where: { coupleId } });
  const userIds = users.map((u) => u.id);
  const phones = users.map((u) => u.phone).filter((p): p is string => !!p);

  console.log(`\n🗑  Deleting ${couple.profileName || coupleId}`);
  console.log(`   users: ${users.map((u) => u.name || u.phone || u.id).join(', ')}`);

  if (userIds.length) {
    const msg = await prisma.message.deleteMany({
      where: { senderUserId: { in: userIds } },
    });
    console.log(`   messages (by user): ${msg.count}`);
  }

  const otp = await prisma.otpToken.deleteMany({
    where: { phone: { in: [...phones, ...PHONES] } },
  });
  console.log(`   otp tokens: ${otp.count}`);

  await prisma.couple.update({
    where: { coupleId },
    data: { partner1Id: null, partner2Id: null },
  });

  await coupleService.deleteMyCouple(coupleId);
  console.log(`   ✅ couple + users removed`);
}

async function main() {
  for (const coupleId of COUPLE_IDS) {
    await deleteCoupleById(coupleId);
  }

  const remaining = await prisma.user.findMany({
    where: { phone: { in: PHONES } },
    select: { id: true, phone: true, name: true },
  });

  if (remaining.length) {
    console.warn('\n⚠️  Some requested users may still exist:', remaining);
  } else {
    console.log('\n✅ All requested accounts removed.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

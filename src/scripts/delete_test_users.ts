import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phones = ['8754388927', '9385359049'];
  console.log(`Starting aggressive deletion for: ${phones.join(', ')}`);

  for (const phone of phones) {
    try {
      // Find the user first to get IDs
      const user = await prisma.user.findUnique({
        where: { phone },
        include: { coupleProfile: true }
      });

      if (!user) {
        console.log(`User ${phone} not found in database.`);
        continue;
      }

      const userId = user.id;
      const coupleId = user.coupleId;

      console.log(`Cleaning up User: ${phone} (ID: ${userId}) and CoupleId: ${coupleId}`);

      // 1. Delete OTPs
      await prisma.otpToken.deleteMany({ where: { phone } });

      // 2. Delete Messages sent by this specific user ID (important for FK)
      await prisma.message.deleteMany({ where: { senderUserId: userId } });

      if (coupleId) {
        const couple = await prisma.couple.findUnique({ where: { coupleId } });
        if (couple) {
          const cid = couple.id; // internal ID
          const cbid = couple.coupleId; // business string ID

          // 3. Delete based on internal Couple.id
          await prisma.notification.deleteMany({
            where: { OR: [{ recipientId: cbid }, { senderId: cbid }] }
          });
          await prisma.report.deleteMany({
            where: { OR: [{ reporterId: cbid }, { targetId: cbid }] }
          });
          await prisma.match.deleteMany({
            where: { OR: [{ couple1Id: cbid }, { couple2Id: cbid }] }
          });

          // 4. Delete Community relations
          await prisma.communityMember.deleteMany({ where: { coupleId: cbid } });
          await prisma.communityJoinRequest.deleteMany({ where: { coupleId: cbid } });
          await prisma.communityAdmin.deleteMany({ where: { coupleId: cbid } });

          // 5. Delete Onboarding
          await prisma.onboardingAnswer.deleteMany({ where: { coupleId: cbid } });

          // 6. Delete Messages sent by the couple entity
          await prisma.message.deleteMany({ where: { senderId: cbid } });

          // 7. Finally delete the couple record
          await prisma.couple.delete({ where: { id: cid } });
          console.log(`Deleted Couple profile: ${cbid}`);
        }
      }

      // 8. Delete the User record
      await prisma.user.delete({ where: { id: userId } });
      console.log(`Successfully deleted User ${phone}`);

    } catch (err) {
      console.error(`Failed to delete ${phone}:`, err);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

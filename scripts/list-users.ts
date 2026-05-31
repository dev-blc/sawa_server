import { prisma } from '../src/lib/prisma';

async function main() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      phone: true,
      name: true,
      email: true,
      role: true,
      coupleId: true,
      isPhoneVerified: true,
      createdAt: true,
      coupleProfile: {
        select: { coupleId: true, profileName: true, locationCity: true },
      },
    },
  });

  const couples = await prisma.couple.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      coupleId: true,
      profileName: true,
      locationCity: true,
      createdAt: true,
      partner1: { select: { id: true, phone: true, name: true } },
      partner2: { select: { id: true, phone: true, name: true } },
    },
  });

  console.log(`\n=== USERS (${users.length}) ===\n`);
  users.forEach((u, i) => {
    console.log(
      `${i + 1}. ${u.name || '(no name)'}\n` +
        `   phone: ${u.phone || '-'}\n` +
        `   email: ${u.email || '-'}\n` +
        `   userId: ${u.id}\n` +
        `   coupleId: ${u.coupleId || '-'}\n` +
        `   profile: ${u.coupleProfile?.profileName || '-'}\n` +
        `   verified: ${u.isPhoneVerified}\n` +
        `   created: ${u.createdAt.toISOString().slice(0, 10)}\n`,
    );
  });

  console.log(`\n=== COUPLES (${couples.length}) ===\n`);
  couples.forEach((c, i) => {
    const p1 = c.partner1
      ? `${c.partner1.name || '?'} (${c.partner1.phone || c.partner1.id})`
      : '—';
    const p2 = c.partner2
      ? `${c.partner2.name || '?'} (${c.partner2.phone || c.partner2.id})`
      : '—';
    console.log(
      `${i + 1}. ${c.profileName || 'Unnamed'}\n` +
        `   coupleId: ${c.coupleId}\n` +
        `   city: ${c.locationCity || '-'}\n` +
        `   partner1: ${p1}\n` +
        `   partner2: ${p2}\n` +
        `   created: ${c.createdAt.toISOString().slice(0, 10)}\n`,
    );
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

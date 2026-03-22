import { prisma } from '../lib/prisma';
import dotenv from 'dotenv';

dotenv.config();

async function checkUsers() {
  try {
    const users = await prisma.user.findMany({});
    console.log('👥 Current Users in DB:');
    users.forEach((u: any) => {
      console.log(`- ID: ${u.id}, Email: ${u.email}, Phone: ${u.phone}, Role: ${u.role}`);
    });
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkUsers();

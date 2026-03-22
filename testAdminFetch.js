const mongoose = require('mongoose');
require('dotenv').config();
const { AdminService } = require('./dist/services/admin.service.js');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const service = new AdminService();
  try {
    const act = await service.getActivities();
    console.log(act);
  } catch (e) {
    console.error(e);
  }
  process.exit();
}
test();

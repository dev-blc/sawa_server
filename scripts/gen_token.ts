import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'sawa_access_secret_dev_change_in_production_32chars';

const payload = {
  userId: 'seed_primary_1', // Dummy ID from seed
  coupleId: 'c87ae7e5-8706-453f-ae0f-656c8730eec3', // Arjun & Meera
  role: 'primary'
};

const token = jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
console.log(token);

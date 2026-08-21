import {
  utcDayStamp,
  secondsToUtcDayEnd,
  smsPrefix8,
  parseCorridorPrefixes,
  corridorAllowed,
  maskPhone,
  assertSmsSendAllowed,
  precheckSmsSendAllowed,
} from '../services/abuseGuard';
import { env } from '../config/env';

// The counters ride lib/cache. Mock it so each cap layer can be tripped
// deterministically without a live Redis (none in the test env).
jest.mock('../lib/cache', () => ({
  cacheGet: jest.fn(),
  cacheIncrExpire: jest.fn(),
  cacheSetNX: jest.fn(),
  cacheSet: jest.fn(),
}));

import { cacheGet, cacheIncrExpire, cacheSetNX } from '../lib/cache';

describe('abuseGuard — pure helpers', () => {
  it('maskPhone keeps country code + 2 and last 2, stars the middle (RULES §3)', () => {
    expect(maskPhone('+919876543210')).toBe('+9198******10');
    expect(maskPhone('12345')).toBe('*****'); // <= 6 digits fully starred
  });

  it('smsPrefix8 identifies a 10k-number block (first 8 E.164 digits)', () => {
    expect(smsPrefix8('+919876543210')).toBe('91987654');
  });

  it('parseCorridorPrefixes normalizes CSV to +NN and drops blanks', () => {
    expect(parseCorridorPrefixes('91, +44 , ')).toEqual(['+91', '+44']);
  });

  it('corridorAllowed matches the allowed corridors only', () => {
    const prefixes = parseCorridorPrefixes('+91,44');
    expect(corridorAllowed('+919876543210', prefixes)).toBe(true);
    expect(corridorAllowed('+447911123456', prefixes)).toBe(true);
    expect(corridorAllowed('+15551234567', prefixes)).toBe(false);
  });

  it('utcDayStamp is a YYYYMMDD bucket and secondsToUtcDayEnd is bounded', () => {
    expect(utcDayStamp(new Date('2026-08-20T05:00:00Z'))).toBe('20260820');
    const s = secondsToUtcDayEnd(new Date('2026-08-20T23:59:00Z'));
    expect(s).toBeGreaterThanOrEqual(60);
    expect(s).toBeLessThanOrEqual(86400);
  });
});

describe('assertSmsSendAllowed — layered caps', () => {
  beforeEach(() => {
    (cacheSetNX as jest.Mock).mockResolvedValue(false); // not first trip → no webhook
    (cacheGet as jest.Mock).mockResolvedValue(null);
    (cacheIncrExpire as jest.Mock).mockResolvedValue({ count: 1, ttlMs: 1000 });
  });

  it('allows an in-corridor send that is under every cap', async () => {
    await expect(
      assertSmsSendAllowed({ phone: '+919876543210', ip: '1.1.1.1', kind: 'otp' }),
    ).resolves.toBeUndefined();
  });

  it('refuses an out-of-corridor destination (400 SMS_REGION_UNSUPPORTED), no counter spent', async () => {
    await expect(
      assertSmsSendAllowed({ phone: '+15551234567', ip: '1.1.1.1', kind: 'otp' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SMS_REGION_UNSUPPORTED' });
    expect(cacheIncrExpire).not.toHaveBeenCalled();
  });

  it('refuses when the per-phone daily cap is exceeded (429, uniform code)', async () => {
    (cacheIncrExpire as jest.Mock).mockImplementation(async (key: string) =>
      key.includes(':phone:')
        ? { count: env.SMS_PHONE_DAILY_CAP + 1, ttlMs: 1000 }
        : { count: 1, ttlMs: 1000 },
    );
    await expect(
      assertSmsSendAllowed({ phone: '+919876543211', ip: '1.1.1.2', kind: 'otp' }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'SMS_LIMIT_REACHED' });
  });

  it('refuses when the per-prefix daily cap is exceeded (429, same uniform code)', async () => {
    (cacheIncrExpire as jest.Mock).mockImplementation(async (key: string) =>
      key.includes(':prefix:')
        ? { count: env.SMS_PREFIX_DAILY_CAP + 1, ttlMs: 1000 }
        : { count: 1, ttlMs: 1000 },
    );
    await expect(
      assertSmsSendAllowed({ phone: '+919876543212', ip: '1.1.1.3', kind: 'otp' }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'SMS_LIMIT_REACHED' });
  });

  it('trips the GLOBAL kill-switch last with a 503', async () => {
    (cacheIncrExpire as jest.Mock).mockImplementation(async (key: string) =>
      key.includes(':global:')
        ? { count: env.SMS_DAILY_GLOBAL_CAP + 1, ttlMs: 1000 }
        : { count: 1, ttlMs: 1000 },
    );
    await expect(
      assertSmsSendAllowed({ phone: '+919876543213', ip: '1.1.1.4', kind: 'otp' }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SMS_TEMPORARILY_UNAVAILABLE' });
  });
});

describe('precheckSmsSendAllowed — multi-SMS signup preflight', () => {
  beforeEach(() => {
    (cacheSetNX as jest.Mock).mockResolvedValue(false);
    (cacheGet as jest.Mock).mockResolvedValue(null);
  });

  it('passes two in-corridor numbers that are under budget', async () => {
    await expect(
      precheckSmsSendAllowed(['+919876543210', '+919812345678'], '2.2.2.2'),
    ).resolves.toBeUndefined();
  });

  it('refuses the whole batch when any number is out of corridor', async () => {
    await expect(
      precheckSmsSendAllowed(['+919876543210', '+15551234567'], '2.2.2.2'),
    ).rejects.toMatchObject({ code: 'SMS_REGION_UNSUPPORTED' });
  });

  it('refuses when the per-IP daily budget cannot fit the batch', async () => {
    (cacheGet as jest.Mock).mockImplementation(async (key: string) =>
      key.includes(':ip:') ? String(env.SMS_IP_DAILY_CAP) : null,
    );
    await expect(
      precheckSmsSendAllowed(['+919876543210', '+919812345678'], '2.2.2.9'),
    ).rejects.toMatchObject({ code: 'SMS_LIMIT_REACHED' });
  });
});

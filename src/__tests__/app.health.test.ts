import request from 'supertest';

// /health deep-checks Postgres via prisma.$queryRaw — mock it so this suite
// verifies the endpoint's CONTRACT (envelope shape + status mapping) without
// needing a live database (none exists in the test environment; Redis is
// optional and already reports 'disabled' without REDIS_URL).
jest.mock('../lib/prisma', () => ({
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) },
}));

import { createApp } from '../app';

describe('App health', () => {
  const app = createApp();

  it('GET /health returns healthy payload', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.body).toMatchObject({
      success: true,
      status: 'healthy',
      service: 'sawa-server',
    });
  });

  it('GET /api/v1 unknown route returns 404', async () => {
    await request(app).get('/api/v1/this-route-does-not-exist').expect(404);
  });
});

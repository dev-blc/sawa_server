import request from 'supertest';
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

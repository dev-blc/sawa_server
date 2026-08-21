import { idempotency } from '../middleware/idempotency';
import * as cache from '../lib/cache';

jest.mock('../lib/cache');
const mockedCache = cache as jest.Mocked<typeof cache>;

const flush = () => new Promise((r) => setImmediate(r));

function mkRes(): any {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b: unknown) => {
    res._body = b;
    return res;
  });
  return res;
}

function mkReq(key?: string): any {
  return {
    header: (h: string) => (h.toLowerCase() === 'idempotency-key' ? key : undefined),
    user: { coupleId: 'c1', userId: 'u1' },
  };
}

describe('idempotency middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes through when there is no key', async () => {
    const next = jest.fn();
    idempotency(mkReq(undefined), mkRes(), next);
    await flush();
    expect(next).toHaveBeenCalled();
  });

  it('replays the stored response verbatim on a repeated key', async () => {
    mockedCache.cacheGet.mockResolvedValue(JSON.stringify({ status: 201, body: { success: true, id: 'x' } }));
    const res = mkRes();
    const next = jest.fn();
    idempotency(mkReq('k1'), res, next);
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, id: 'x' });
  });

  it('claims a first-seen key, runs the handler, and stores the success', async () => {
    mockedCache.cacheGet.mockResolvedValue(null);
    mockedCache.cacheSetNX.mockResolvedValue(true);
    mockedCache.cacheSet.mockResolvedValue(undefined);
    const res = mkRes();
    const next = jest.fn();
    idempotency(mkReq('k2'), res, next);
    await flush();
    expect(next).toHaveBeenCalled();
    // Simulate the handler sending a success.
    res.status(201);
    res.json({ success: true });
    expect(mockedCache.cacheSet).toHaveBeenCalled();
  });

  it('409s a concurrent in-flight duplicate (lock not claimed)', async () => {
    mockedCache.cacheGet.mockResolvedValue(null);
    mockedCache.cacheSetNX.mockResolvedValue(false);
    const res = mkRes();
    const next = jest.fn();
    idempotency(mkReq('k3'), res, next);
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('fails open when the cache throws', async () => {
    mockedCache.cacheGet.mockRejectedValue(new Error('redis down'));
    const next = jest.fn();
    idempotency(mkReq('k4'), mkRes(), next);
    await flush();
    expect(next).toHaveBeenCalled();
  });
});

import { redisRetryStrategy } from './redis.module';

describe('redisRetryStrategy', () => {
  it('backs off linearly with a cap', () => {
    expect(redisRetryStrategy(1)).toBe(100);
    expect(redisRetryStrategy(10)).toBe(1000);
    expect(redisRetryStrategy(1_000)).toBe(3000);
  });

  it('never gives up, however many attempts have failed', () => {
    // Regression: the strategy used to return `null` after 10 attempts, and
    // ioredis reads `null` as "stop reconnecting" — permanently. A Redis
    // outage longer than the retry window (~6s) therefore left the gateway
    // unable to reconnect even after Redis came back: `/health/ready` stayed
    // 503 and every Redis-backed surface kept failing until a restart.
    // A live failure-injection sweep caught it; no unit test could.
    for (const times of [1, 5, 10, 11, 50, 1_000, 1_000_000]) {
      const delay = redisRetryStrategy(times);
      expect(delay).not.toBeNull();
      expect(delay).not.toBeUndefined();
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
      expect(Number.isFinite(delay)).toBe(true);
    }
  });
});

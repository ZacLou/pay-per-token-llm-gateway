import { Global, Module, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from '@x402/config';

/**
 * Reconnect backoff for the Redis client.
 *
 * Deliberately never returns `null`. ioredis treats `null` from
 * `retryStrategy` as "stop reconnecting" — *permanently*. A Redis outage longer
 * than the retry window would then leave the process unable to recover: Redis
 * could come back and `/health/ready` would still report it down forever, and
 * every Redis-backed surface (rate limiting, sessions, replay claims) would go
 * on failing until someone restarted the process.
 *
 * Failing fast at startup does not depend on this: `onModuleInit` pings Redis
 * and throws if it is unreachable, so the gateway refuses to start rather than
 * hanging.
 */
export function redisRetryStrategy(times: number): number {
  return Math.min(times * 100, 3000);
}

const redisProvider = {
  provide: 'REDIS',
  useFactory: () => {
    const config = getConfig();
    return new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      // Connect timeout so a down Redis surfaces a readiness error instead of
      // hanging forever.
      connectTimeout: 5_000,
      retryStrategy: redisRetryStrategy,
      // Connect eagerly so connection failures surface at startup,
      // not at the first request.
      lazyConnect: false,
    });
  },
};

@Global()
@Module({
  providers: [redisProvider],
  exports: ['REDIS'],
})
export class RedisModule implements OnModuleInit {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject('REDIS') private readonly redis: Redis) {}

  async onModuleInit() {
    const config = getConfig();
    const isProduction = config.nodeEnv === 'production';

    try {
      await this.redis.ping();
      this.logger.log('✅ Redis connected');
    } catch (error) {
      const message =
        `Redis connection failed: ${String(error)}. ` +
        (isProduction
          ? 'Redis is REQUIRED in production — the gateway cannot start without it. ' +
            'Check that REDIS_URL is correct and the Redis server is reachable.'
          : 'Start a Redis server (docker compose up -d redis) or set REDIS_URL.');
      this.logger.error(message);
      throw new Error(message);
    }
  }
}

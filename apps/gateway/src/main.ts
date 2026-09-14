import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Express, json } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { MetricsService } from './common/metrics.service';
import { createTraceContextMiddleware } from './common/trace-context.middleware';
import { assertSchemaMigrated } from './common/schema-guard';
import { getConfig, validateEnv } from '@x402/config';
import { logger, enableJsonLogs } from '@x402/logger';
import { prisma } from '@x402/database';

async function bootstrap() {
  // Fail fast if required environment variables are missing
  validateEnv();

  // Fail fast if the database schema was never migrated.
  //
  // A deploy that skips `prisma migrate deploy` otherwise boots "healthy"
  // against an empty database — /health answers and the readiness SELECT 1
  // succeeds, because neither needs a table — and then every API call fails
  // with a Prisma "table does not exist" error at request time. Checking here
  // turns that silent outage into an unmissable startup failure.
  //
  // A `db push`-managed database (the documented local workflow) has no
  // migration history but a complete schema: that is only refused in
  // production, where the entrypoint guarantees `migrate deploy` has run.
  await assertSchemaMigrated(prisma, {
    nodeEnv: process.env.NODE_ENV,
    warn: (message) => logger.warn(message),
  });

  // Structured JSON logs in production for log aggregators
  if (process.env.NODE_ENV === 'production') {
    enableJsonLogs();
  }

  const config = getConfig();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // we set it explicitly below with a size limit
  });

  // Security headers (CSP, X-Frame-Options, HSTS, nosniff, etc.)
  app.use(helmet());

  // W3C trace context: continue or start a trace, propagate `traceparent` on
  // responses, record an `http.request` span per request. Must run before
  // route handling so controllers can create child spans via req.traceContext.
  app.use(createTraceContextMiddleware(app.get(MetricsService)));

  // Cookie parser — required for reading httpOnly session cookies set by
  // the auth controller and sent automatically by the browser.
  app.use(cookieParser());

  // Body size limit: 1 MB is enough for any reasonable chat completion request
  app.use(json({ limit: '1mb' }));

  // Global prefix — health + metrics endpoints are excluded so load
  // balancers and Prometheus scrapers can hit /health and /metrics directly.
  // Sub-paths need explicit wildcard entries: 'health' alone only matches
  // the exact /health route, not /health/live or /health/ready.
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/(.*)', 'metrics', 'metrics/(.*)'],
  });

  // CORS
  app.enableCors({
    origin: config.security.corsOrigins,
    credentials: true,
  });

  // Explicit proxy trust. `request.ip` (used by IP-based rate limiting) is
  // taken from the socket unless a proxy is explicitly trusted. Trusting
  // proxy headers while directly exposed lets a client forge X-Forwarded-For
  // and rotate source IPs at will, so the safe default is `false` (ignore
  // forwarded headers) and trusting a proxy requires setting TRUST_PROXY
  // (e.g. "1" for a single hop, "loopback", or a proxy IP list).
  // See https://expressjs.com/en/guide/behind-proxies.html
  const trustProxy = config.security.trustProxy;
  const httpServer = app.getHttpAdapter().getInstance() as Express;
  httpServer.set('trust proxy', trustProxy);
  if (trustProxy === false) {
    const message =
      'TRUST_PROXY is disabled: X-Forwarded-For/X-Real-IP are ignored and ' +
      'request.ip comes from the socket. Set TRUST_PROXY only when the ' +
      'gateway runs behind a trusted reverse proxy.';
    if (config.nodeEnv === 'production') {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  } else {
    logger.info(`trust proxy enabled: ${String(trustProxy)}`);
  }

  // Hard upper bounds on the HTTP server itself: a client that never finishes
  // sending its request (or its headers) must not hold a connection open
  // indefinitely. The 300s ceiling is well above any legitimate request;
  // streaming LLM responses are unaffected (these limits govern request
  // receipt, not response duration).
  const rawServer = app.getHttpServer() as import('http').Server;
  rawServer.requestTimeout = 300_000;
  rawServer.headersTimeout = 65_000;

  // Global exception filter (consistent error format + Retry-After for 429)
  app.useGlobalFilters(new HttpExceptionFilter());

  // Prometheus request metrics for every route
  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('x402 LLM Gateway')
    .setDescription(
      'Pay-per-request LLM gateway using x402 stablecoin micropayments on Stellar.\n\n' +
        'No API keys — just pay in USDC on Stellar and get access to any LLM endpoint.',
    )
    .setVersion('0.1.0')
    .addTag('x402', 'x402 payment protocol endpoints')
    .addTag('proxy', 'LLM proxy endpoints')
    .addTag('providers', 'Provider management')
    .addTag('payments', 'Payment history and status')
    .addTag('analytics', 'Usage and revenue analytics')
    .addTag('admin', 'Admin operations')
    .addTag('health', 'Health check')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Graceful shutdown: close HTTP server + DB/Redis connections on SIGTERM/SIGINT
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  const publicBase = config.publicBaseUrl || `http://${config.host}:${config.port}`;
  logger.info(`🚀 x402 Gateway running on ${publicBase}`, {
    network: config.stellar.network,
    docs: `${publicBase}/api/docs`,
    health: `${publicBase}/health`,
  });
}

bootstrap();

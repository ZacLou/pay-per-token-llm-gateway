import {
  Controller,
  All,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
import { X402Service } from '../x402/x402.service';
import { RoutesService } from '../routes/routes.service';
import { PaymentsService } from '../payments/payments.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AdminService } from '../admin/admin.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { MetricsService } from '../../common/metrics.service';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { childSpan, type TraceRequest } from '../../common/trace-context.middleware';
import { serializeTraceparent } from '@x402/logger';
import { chatCompletionRequestSchema, txHashSchema } from '@x402/validation';
import { calculatePrice, comparePayment, DEFAULT_TOKEN_ESTIMATE } from '@x402/x402-core';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { generateId } from '@x402/shared';
import { settleEscrow } from '../x402/escrow-client';
import type { ChatCompletionRequest, PaymentRecord, Quote, RouteConfig } from '@x402/types';

@ApiTags('proxy')
@Controller()
@UseGuards(RateLimitGuard)
export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly x402Service: X402Service,
    private readonly routesService: RoutesService,
    private readonly paymentsService: PaymentsService,
    private readonly analyticsService: AnalyticsService,
    private readonly adminService: AdminService,
    private readonly webhooksService: WebhooksService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Main proxy endpoint — catches all LLM API requests.
   *
   * Flow:
   * 1. Validate the request body
   * 2. Look up the route for the requested model + path
   * 3. If no payment header: generate quote (with token estimate for per-token), store pending payment, return 402
   * 4. If payment: verify on-chain, then:
   *    - stream=true → pipe SSE stream from upstream to client
   *    - stream=false → forward, collect full response, calculate actual cost for per-token, return JSON
   */
  @All('chat/completions')
  @HttpCode(HttpStatus.OK)
  async handleChatCompletion(@Req() req: Request, @Res() res: Response) {
    // The trace context (W3C `traceparent`) was established by the
    // trace-context middleware; controllers derive child spans from it.
    const traceContext = (req as TraceRequest).traceContext;
    const traceId = traceContext?.traceId ?? generateId();
    const startTime = Date.now();

    try {
      // 1. Validate request
      const parseResult = chatCompletionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestException({
          status: 400,
          error: 'Bad Request',
          message: 'Invalid chat completion request',
          details: parseResult.error.flatten(),
        });
      }
      const body = parseResult.data;
      const model = body.model;

      // 2. Look up the route for the requested model. Path normalization
      // (stripping the gateway prefix and matching `/v1` conventions) is
      // handled inside RoutesService so the matching logic stays in one place.
      const route = await this.routesService.findByPathAndModel(req.path, model);
      if (!route) {
        return res.status(404).json({
          status: 404,
          error: 'Not Found',
          message: `No route configured for model: ${model}`,
        });
      }

      // 3. Check for payment headers.
      //    - X-Payment-Hash: a 64-char hex Horizon transaction hash (per-request payment)
      //    - X-Escrow-User: a Stellar address that has prepaid credit in the
      //      credit-escrow contract. When the balance covers the quote amount,
      //      Horizon payment verification is skipped.
      const txHash = req.headers['x-payment-hash'] as string | undefined;
      const escrowUser = req.headers['x-escrow-user'] as string | undefined;

      if (txHash !== undefined) {
        const txParse = txHashSchema.safeParse(txHash);
        if (!txParse.success) {
          return res.status(400).json({
            status: 400,
            error: 'Bad Request',
            message: 'Invalid X-Payment-Hash header: expected a 64-character hexadecimal string',
          });
        }
      }
      if (!txHash && !escrowUser) {
        const quoteSpan = childSpan('quote.generate', req as TraceRequest, {
          model,
          pricingModel: route.pricingModel,
        });
        await this.handle402Response(res, route, traceId, model, body);
        quoteSpan.end({ model, route: route.path });
        return;
      }

      let payment: PaymentRecord | null = null;

      // 4. Verify payment (includes cross-route replay protection). The
      //    span wraps the whole verify → claim → debt-gate path so its
      //    duration reflects the full on-chain verification.
      const verifySpan = childSpan('payment.verify', req as TraceRequest, { txHash });
      if (escrowUser) {
        payment = await this.verifyAndConfirmEscrowPayment(escrowUser, route, res, traceId, body);
      } else if (txHash) {
        const verified = await this.verifyAndConfirmPayment(txHash, route, res, traceId);
        if (verified) {
          payment = await this.paymentsService.findByTxHash(txHash);
        }
      }
      verifySpan.end({ txHash, verified: !!payment });
      if (!payment) {
        return; // 402 error response already sent
      }

      // 5. Resolve upstream API key
      const upstreamApiKey =
        process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];

      // 6. Bound per-token completions to what the deposit covers (see
      //    capForwardBody): never forward an uncapped request whose deposit
      //    was estimated from the default token budget.
      const forwardBody = this.capForwardBody(body, route, payment);

      // Span over the upstream forward + metered settlement. The W3C context
      // is propagated to the upstream as `traceparent` alongside the legacy
      // X-Request-Trace-Id header.
      const forwardSpan = childSpan('upstream.forward', req as TraceRequest, {
        model: body.model,
        stream: !!body.stream,
      });
      const upstreamTraceparent = traceContext ? serializeTraceparent(traceContext) : undefined;

      if (body.stream) {
        await this.handleStreamingForward(
          res,
          forwardBody,
          route,
          payment?.txHash || '',
          upstreamApiKey,
          payment,
          traceId,
          startTime,
          upstreamTraceparent,
        );
      } else {
        await this.handleNonStreamingForward(
          res,
          forwardBody,
          route,
          payment?.txHash || txHash || '',
          upstreamApiKey,
          payment,
          traceId,
          startTime,
          upstreamTraceparent,
        );
      }
      forwardSpan.end({ model: body.model, stream: !!body.stream });
      return;
    } catch (error) {
      logger.error('Proxy error', { traceId, error: String(error) });

      if (error instanceof BadRequestException) {
        return res.status(400).json({
          status: 400,
          error: 'Bad Request',
          message: error.message,
        });
      }

      return res.status(502).json({
        status: 502,
        error: 'Bad Gateway',
        message: 'Upstream LLM request failed',
      });
    }
  }

  // ── Helper methods ───────────────────────────

  /**
   * Cap the forwarded completion length for per-token routes.
   *
   * Per-token deposits are estimated from `max_tokens` (or a default budget
   * when the client omits it). If the client omitted `max_tokens`, an
   * uncapped upstream response could generate far more completion tokens than
   * the deposit covers — so forward with `max_tokens` set to exactly the
   * budget the deposit was estimated from. Clients that supplied their own
   * `max_tokens` are already bounded server-side and pass through untouched.
   *
   * Note: this bounds completion tokens; prompt tokens are still unbounded
   * and still billed, which the underpayment debt gate (verifyAndConfirm
   * Payment) exists to enforce.
   */
  private capForwardBody(
    body: ChatCompletionRequest,
    route: RouteConfig,
    payment: PaymentRecord | null,
  ): ChatCompletionRequest {
    if (route.pricingModel !== 'per_token' || body.max_tokens !== undefined) return body;

    // The quote used for this payment carries the exact estimate the deposit
    // was based on (falls back to the shared default for payment rows whose
    // receipt was written before the field existed).
    const quote = payment?.receiptJson ? (payment.receiptJson as Quote) : null;
    const budget = quote?.estimatedMaxTokens ?? DEFAULT_TOKEN_ESTIMATE;
    logger.info('Capping forwarded max_tokens to deposit estimate', {
      model: body.model,
      max_tokens: budget,
      pricingModel: route.pricingModel,
    });
    return { ...body, max_tokens: budget };
  }

  /**
   * Send a 402 Payment Required response.
   * For per-token routes, estimates cost based on request max_tokens.
   */
  private async handle402Response(
    res: Response,
    route: RouteConfig,
    traceId: string,
    model: string,
    body: ChatCompletionRequest,
  ) {
    logger.info('402: Payment required', { traceId, model });

    // For per-token pricing, estimate from the request's max_tokens
    const estimatedTokens =
      route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;

    const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
    const payment402 = await this.x402Service.build402Response(quote);

    await this.paymentsService.createPendingPayment(quote, route);
    await this.analyticsService.recordUnpaidRequest(route.path, route.providerId);

    await this.adminService.writeAuditLog({
      action: 'quote_generated',
      entity: 'quote',
      entityId: quote.id,
      providerId: route.providerId,
      actor: 'system',
      details: {
        model,
        route: route.path,
        amount: quote.amount,
        pricingModel: route.pricingModel,
        estimatedTokens,
        traceId,
      },
    });

    return res.status(402).json(payment402);
  }

  /**
   * Verify payment on-chain and confirm it. Returns true if verified.
   */
  private async verifyAndConfirmPayment(
    txHash: string,
    route: RouteConfig,
    res: Response,
    traceId: string,
  ): Promise<boolean> {
    logger.info('Verifying payment', { traceId, txHash });

    let existingPayment = await this.paymentsService.findByTxHash(txHash);

    // SECURITY — single-use invariant. A confirmed payment row means this
    // txHash has already been consumed; it must never grant access a second
    // time. Previously a confirmed row on the SAME route short-circuited to
    // `true`, letting callers pay once and replay the hash indefinitely for
    // unlimited LLM access (and bypassing Redis/on-chain replay protection,
    // which were only consulted for not-yet-confirmed payments). Cross-route
    // replays are rejected first for a clearer message; same-route replays
    // are rejected here — the DB row is evidence of consumption, never proof
    // of freshness.
    if (existingPayment?.status === 'confirmed') {
      if (existingPayment.routeId !== route.id) {
        logger.warn('Cross-route replay attempt', {
          traceId,
          txHash,
          existingRoute: existingPayment.routeId,
          requestedRoute: route.id,
        });
        res.status(402).json({
          status: 402,
          error: 'Payment Required',
          message: 'This payment was made for a different route. A new payment is required.',
        });
        return false;
      }

      logger.warn('Payment replay attempt (hash already used)', {
        traceId,
        txHash,
        routeId: existingPayment.routeId,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    // First-time payment: no row carries this hash yet — the quote's own row
    // is still pending with `txHash = NULL`, so the lookup above misses it.
    // Resolve that quote from the transaction's on-chain memo, which is derived
    // deterministically from the quote id. Without this, verification would
    // mint a *new* quote at retry time and reject the (older, valid) payment
    // with "Payment was made before the quote was issued". Best-effort: when
    // the client paid without a memo, or no pending quote on this route
    // matches, we fall through to the previous behavior — and the fresh
    // quote's `issuedAt` lower bound still rejects historical payments, so an
    // unresolved payment can never grant access.
    if (!existingPayment) {
      const memo = await this.x402Service.fetchTransactionMemo(txHash);
      if (memo) {
        existingPayment = await this.paymentsService.findPendingByQuoteMemo(memo, route.id);
        if (existingPayment) {
          logger.info('Resolved payment to its originating quote via memo', {
            traceId,
            txHash,
            quoteId: existingPayment.quoteId,
          });
        }
      }
    }

    // Use the original quote from the pending payment, or generate a new one.
    // CRITICAL: if the original quote has expired, reject even if the payment
    // was technically on-chain — the quote window is a security boundary.
    const storedQuote = existingPayment?.receiptJson
      ? (existingPayment.receiptJson as Quote)
      : null;

    if (storedQuote && this.x402Service.isQuoteExpired(storedQuote)) {
      logger.warn('Payment made with expired quote', {
        traceId,
        txHash,
        quoteId: storedQuote.id,
        expiresAt: storedQuote.expiresAt,
        now: Date.now() / 1000,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'The payment quote has expired. Please request a new quote and pay again.',
      });
      return false;
    }

    // If no stored quote exists, generate one for verification.
    // (This handles the case where a payment arrives without a prior 402 quote.)
    const quoteForVerification =
      storedQuote ?? (await this.x402Service.generateQuoteForRoute(route));

    const verification = await this.x402Service.verifyPayment(txHash, quoteForVerification);

    if (!verification.verified) {
      logger.warn('Payment verification failed', {
        traceId,
        txHash,
        reason: verification.failureReason,
      });
      await this.adminService.writeAuditLog({
        action: 'payment_verification_failed',
        entity: 'payment',
        entityId: txHash,
        providerId: route.providerId,
        actor: verification.payerAddress,
        details: {
          reason: verification.failureReason,
          route: route.path,
          traceId,
        },
      });

      // Record the failure so the dashboard's failed-verification time-series
      // is real data. Nothing writes `payment:failed` otherwise, which left
      // that metric permanently at zero.
      await this.analyticsService
        .recordPaymentFailed(route.path, route.providerId, verification.payerAddress || 'unknown')
        .catch((err) =>
          logger.error('Analytics recordPaymentFailed error', { traceId, error: String(err) }),
        );

      // Notify provider of verification failure
      this.webhooksService
        .notifyVerificationFailed(route.providerId, {
          txHash,
          reason: verification.failureReason || 'Unknown reason',
        })
        .catch((err) =>
          logger.error('Webhook notifyVerificationFailed error', { traceId, error: String(err) }),
        );

      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: `Payment verification failed: ${verification.failureReason}`,
      });
      return false;
    }

    // ── Underpayment debt gate (per-token enforcement) ────────────
    //
    // A payer with open underpayment debt on this provider must top up before
    // receiving further LLM access. The arriving on-chain payment must cover
    // the current quote deposit PLUS all outstanding debt; the surplus over
    // the deposit is the debt repayment and clears the ledger. When the
    // payment is insufficient we answer 402 with a quote for the combined
    // amount so the SDK auto-pays the top-up in a single transaction.
    //
    // Quotes always carry the pure deposit (never the debt), so the same
    // deposit basis is used here and in the metered settlement below. The
    // refused payment is deliberately not claimed — it stays on-chain to the
    // provider (the protocol has no refund path) and its hash is already
    // consumed by Redis/on-chain replay protection, so it cannot be replayed.
    const openDebt = await this.paymentsService.getOpenDebtTotal(
      verification.payerAddress,
      route.providerId,
    );
    if (openDebt > 0n) {
      const deposit = BigInt(quoteForVerification.amount);
      const requiredTotal = deposit + openDebt;
      if (BigInt(verification.amount) < requiredTotal) {
        logger.warn('Underpayment debt outstanding — access denied until topped up', {
          traceId,
          txHash,
          payerAddress: verification.payerAddress,
          providerId: route.providerId,
          debt: openDebt.toString(),
          paid: verification.amount,
          requiredTotal: requiredTotal.toString(),
        });

        await this.adminService.writeAuditLog({
          action: 'payment_debt_denied',
          entity: 'payment',
          entityId: txHash,
          providerId: route.providerId,
          actor: verification.payerAddress,
          details: {
            debt: openDebt.toString(),
            paid: verification.amount,
            requiredTotal: requiredTotal.toString(),
            route: route.path,
            traceId,
          },
        });

        // Fresh deposit quote, amount bumped to deposit + debt so the client
        // SDK pays the top-up in one transaction.
        const baseQuote = await this.x402Service.generateQuoteForRoute(route);
        const topUpQuote: Quote = { ...baseQuote, amount: requiredTotal.toString() };
        const debtRequiredResponse = await this.x402Service.build402Response(topUpQuote);
        res.status(402).json(debtRequiredResponse);
        return false;
      }

      // Payment covers deposit + debt → the surplus is the repayment.
      await this.paymentsService.settleUnderpaymentDebts(
        verification.payerAddress,
        route.providerId,
      );
      logger.info('Underpayment debt settled by top-up payment', {
        traceId,
        txHash,
        payerAddress: verification.payerAddress,
        providerId: route.providerId,
        debt: openDebt.toString(),
      });
    }

    // Atomically claim the payment. `confirmPayment` returns null when a
    // concurrent request already consumed this hash (single-use invariant)
    // — in that case the caller must NOT receive LLM access.
    const claimResult = existingPayment
      ? await this.paymentsService.confirmPayment(existingPayment.quoteId, verification)
      : await (async () => {
          await this.paymentsService.createPendingPayment(quoteForVerification, route);
          return this.paymentsService.confirmPayment(quoteForVerification.id, verification);
        })();

    if (!claimResult) {
      logger.warn('Payment replay attempt (claim lost to concurrent request)', {
        traceId,
        txHash,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    await this.adminService.writeAuditLog({
      action: 'payment_verified',
      entity: 'payment',
      entityId: txHash,
      providerId: route.providerId,
      actor: verification.payerAddress,
      details: {
        amount: verification.amount,
        asset: verification.asset,
        route: route.path,
        traceId,
      },
    });

    // Notify provider of payment received
    this.webhooksService
      .notifyPaymentReceived(route.providerId, {
        txHash,
        amount: verification.amount || '0',
        asset: verification.asset || 'USDC',
        payerAddress: verification.payerAddress || 'unknown',
      })
      .catch((err) =>
        logger.error('Webhook notifyPaymentReceived error', { traceId, error: String(err) }),
      );

    return true;
  }

  /**
   * Verify a prepaid escrow balance and confirm it as payment.
   *
   * Generates an internal quote so the payment record and settlement path
   * can be reused. Returns the confirmed PaymentRecord on success, or null
   * when the balance is insufficient (a 402 has already been sent).
   */
  private async verifyAndConfirmEscrowPayment(
    escrowUser: string,
    route: RouteConfig,
    res: Response,
    traceId: string,
    body: ChatCompletionRequest,
  ): Promise<PaymentRecord | null> {
    logger.info('Verifying escrow payment', { traceId, escrowUser: escrowUser.slice(0, 8) });

    const estimatedTokens =
      route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;
    const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
    const verification = await this.x402Service.verifyEscrowPayment(escrowUser, quote);

    if (!verification.verified) {
      logger.warn('Escrow verification failed', {
        traceId,
        escrowUser: escrowUser.slice(0, 8),
        reason: verification.failureReason,
      });

      // Build a 402 response so the caller can fall back to per-request payment.
      const payment402 = await this.x402Service.build402Response(quote);
      await this.paymentsService.createPendingPayment(quote, route);
      await this.analyticsService.recordUnpaidRequest(route.path, route.providerId);

      res.status(402).json({
        ...payment402,
        message: `Escrow payment failed: ${verification.failureReason}. ${payment402.message}`,
      });
      return null;
    }

    // Create and confirm a synthetic payment record for this escrow draw.
    await this.paymentsService.createPendingPayment(quote, route);
    const claimResult = await this.paymentsService.confirmPayment(quote.id, verification);

    if (!claimResult) {
      logger.warn('Escrow replay attempt (claim lost to concurrent request)', {
        traceId,
        escrowUser: escrowUser.slice(0, 8),
        quoteId: quote.id,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This escrow quote has already been used. Please request a new quote.',
      });
      return null;
    }

    await this.adminService.writeAuditLog({
      action: 'escrow_payment_verified',
      entity: 'payment',
      entityId: quote.id,
      providerId: route.providerId,
      actor: escrowUser,
      details: {
        amount: verification.amount,
        asset: verification.asset,
        route: route.path,
        traceId,
      },
    });

    return this.paymentsService.findByQuoteId(quote.id);
  }

  /**
   * Forward a streaming request: pipe SSE chunks from upstream to client.
   * For per-token routes, calculates actual cost from final SSE usage chunk.
   *
   * After the stream completes, sends cost/receipt data as a trailing SSE
   * event so the SDK can extract payment info from streaming responses.
   */
  private async handleStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    startTime: number,
    traceparent?: string,
  ) {
    logger.info('Forwarding streaming request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    res.setHeader('X-Request-Trace-Id', traceId);

    if (payment) {
      res.setHeader(
        'X-Payment-Receipt',
        JSON.stringify({
          id: payment.id,
          quoteId: payment.quoteId,
          txHash: payment.txHash,
          payerAddress: payment.payerAddress,
          amount: payment.amount?.toString(),
          asset: payment.asset,
          route: route.path,
          status: payment.status,
          actualCost: payment.amount?.toString() || '0',
          tokensUsed: null,
        }),
      );
    }

    // Pipe upstream SSE stream to client; extract tokens for per-token pricing
    await this.proxyService.forwardStreamRequest(
      body,
      route.upstreamUrl,
      res,
      apiKey,
      traceId,
      traceparent,
      async (totalTokens) => {
        const streamDuration = Date.now() - startTime;

        // Calculate actual cost for per-token pricing
        const costResult = await this.applyMeteredPricing(
          route,
          payment,
          totalTokens,
          res,
          traceId,
        );

        // Send cost/receipt as a trailing SSE event so the SDK can extract
        // payment info from streaming responses (response headers were
        // already flushed). The proxy service emits the terminal `[DONE]`
        // AFTER this callback returns, so the receipt is always delivered
        // before [DONE] and clients that stop at [DONE] still see it.
        if (payment) {
          const receipt = {
            id: payment.id,
            quoteId: payment.quoteId,
            txHash: payment.txHash,
            payerAddress: payment.payerAddress,
            amount: payment.amount?.toString(),
            asset: payment.asset,
            // The receipt must name the route it paid for (#46) — clients
            // reconcile the receipt against the endpoint they called.
            route: route.path,
            status: payment.status,
            actualCost: costResult.actualCost,
            tokensUsed: totalTokens ?? null,
          };
          try {
            res.write(`data: ${JSON.stringify({ x402_receipt: receipt })}\n\n`);
          } catch {
            /* client disconnected — stream already ended */
          }
        }

        await this.analyticsService.recordPaidRequest(
          route.path,
          route.providerId,
          payment?.payerAddress || 'unknown',
          costResult.actualCost,
          payment?.asset || 'USDC',
          streamDuration,
        );
      },
    );

    await this.adminService.writeAuditLog({
      action: 'request_forwarded_stream',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: { model: body.model, route: route.path, txHash, traceId },
    });
  }

  /**
   * Forward a non-streaming request: collect full response and return as JSON.
   * For per-token routes, calculates actual cost from response usage.total_tokens.
   */
  private async handleNonStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    _startTime: number,
    traceparent?: string,
  ) {
    logger.info('Forwarding request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    const { response, responseTime } = await this.proxyService.forwardRequest(
      body,
      route.upstreamUrl,
      apiKey,
      traceId,
      traceparent,
    );

    // Calculate actual cost for per-token pricing
    const tokensUsed = response.usage?.total_tokens;
    const costResult = await this.applyMeteredPricing(route, payment, tokensUsed, res, traceId);

    await this.analyticsService.recordPaidRequest(
      route.path,
      route.providerId,
      payment?.payerAddress || 'unknown',
      costResult.actualCost,
      payment?.asset || 'USDC',
      responseTime,
    );

    // Add x402 receipt header
    if (payment) {
      res.setHeader(
        'X-Payment-Receipt',
        JSON.stringify({
          id: payment.id,
          quoteId: payment.quoteId,
          txHash: payment.txHash,
          payerAddress: payment.payerAddress,
          amount: payment.amount?.toString(),
          asset: payment.asset,
          // Populate the route so `X-Payment-Receipt` is self-describing (#46).
          route: route.path,
          status: payment.status,
          actualCost: costResult.actualCost,
          tokensUsed: tokensUsed ?? null,
        }),
      );
    }
    res.setHeader('X-Request-Trace-Id', traceId);

    await this.adminService.writeAuditLog({
      action: 'request_forwarded',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        responseTime,
        tokens: tokensUsed,
        actualCost: costResult.actualCost,
        surplus: costResult.surplus,
        traceId,
      },
    });

    return res.json(response);
  }

  // ── Per-Token Metered Pricing ──────────────

  /**
   * Apply per-token metered pricing after receiving the LLM response.
   *
   * For flat-rate routes: simply returns the paid amount as the actual cost.
   * For per-token routes:
   *   1. Calculates actual cost from tokens used × perTokenPrice
   *   2. Compares against the paid amount
   *   3. Sets X-Actual-Cost, X-Tokens-Used headers
   *   4. Records the actual cost on the payment
   *   5. Returns the cost details for analytics
   */
  private async applyMeteredPricing(
    route: RouteConfig,
    payment: PaymentRecord | null,
    tokensUsed: number | undefined,
    res: Response,
    traceId: string,
  ): Promise<{
    actualCost: string;
    surplus: string;
    isOverpaid: boolean;
    isUnderpaid: boolean;
  }> {
    if (route.pricingModel !== 'per_token' || !tokensUsed) {
      // Flat-rate or no token data: actual cost = paid amount
      const paid = payment?.amount?.toString() || '0';
      if (!res.headersSent) {
        res.setHeader('X-Actual-Cost', paid);
      }

      // Escrow-funded draws must still be debited here. Returning without
      // settling would let a caller with any escrow balance ≥ the quote make
      // unlimited requests on flat-rate routes while the prepaid balance is
      // never consumed. (Horizon-funded requests settle in the transfer
      // itself and are skipped inside the helper.)
      await this.settleEscrowDraw(payment, paid, '0', false, traceId);

      return {
        actualCost: paid,
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      };
    }

    // Calculate actual per-token cost
    const priceResult = calculatePrice({ route, tokenCount: tokensUsed });
    const actualCost = priceResult.amount;

    // Compare against paid amount
    const paidAmount = payment?.amount?.toString() || actualCost;
    const comparison = comparePayment(paidAmount, actualCost);

    // Set response headers (skip if streaming — headers already flushed)
    if (!res.headersSent) {
      res.setHeader('X-Actual-Cost', actualCost);
      res.setHeader('X-Tokens-Used', String(tokensUsed));
      res.setHeader('X-Paid-Amount', paidAmount);
      if (comparison.surplus !== '0') {
        res.setHeader('X-Surplus', comparison.surplus);
      }
    }

    // Record actual cost on the payment. On-chain settlement for escrow draws
    // happens exactly once, below (`settleEscrowDraw`). Charging here as well
    // would consume the contract's per-quote idempotency guard first and make
    // the settlement charge fail — leaving the surplus refund permanently
    // unexecuted and the caller overcharged.
    if (payment) {
      await this.paymentsService.recordActualCost(payment.quoteId, actualCost, tokensUsed);
    }

    logger.info('Per-token cost calculated', {
      traceId,
      tokensUsed,
      actualCost,
      paidAmount,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    });

    if (comparison.isUnderpaid) {
      logger.warn('Per-token underpayment detected', {
        traceId,
        tokensUsed,
        actualCost,
        paidAmount,
        shortfall: comparison.surplus,
      });

      // Record the deficit as open debt so future access from this payer on
      // this provider is gated until topped up (see the debt gate in
      // verifyAndConfirmPayment). The response is already delivered — this
      // ledger is what makes the underpayment recoverable on the next visit.
      if (payment?.payerAddress) {
        await this.paymentsService.recordUnderpaymentDebt({
          quoteId: payment.quoteId,
          providerId: route.providerId,
          routeId: route.id,
          payerAddress: payment.payerAddress,
          amount: comparison.surplus.replace('-', ''), // deficit = −surplus
        });
        this.metrics.safe(() => this.metrics.underpaymentDebtsRecorded.inc());
      }
    }

    // Escrow settlement: charge actual cost + refund surplus from the
    // caller's credit-escrow balance. Best-effort (fire-and-forget) — the
    // LLM response has already been delivered; on-chain settlement must
    // never block it.
    await this.settleEscrowDraw(
      payment,
      actualCost,
      comparison.surplus,
      comparison.isOverpaid,
      traceId,
    );

    return {
      actualCost,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    };
  }

  /**
   * Settle a metered response against the caller's prepaid escrow balance:
   * charge the actual cost and refund any unused deposit.
   *
   * Only escrow draws (`X-Escrow-User`, recorded with a synthetic
   * `escrow:<quoteId>` hash) touch the credit-escrow contract. A request paid
   * per-request on-chain via Horizon has already settled in the payment
   * transfer itself — debiting the same wallet's escrow balance on top would
   * double-bill it, so those draws pass `enabled: false` and the settlement
   * helper is a no-op.
   *
   * Idempotency: the contract's `charge` and `refund` are each guarded per
   * `(user, quoteId)`, and this method is the single settlement call site, so
   * a retried or duplicated settlement can never double-deduct.
   *
   * Fire-and-forget by design: the LLM response has already been delivered,
   * so on-chain settlement must never block (or fail) it.
   */
  private async settleEscrowDraw(
    payment: PaymentRecord | null,
    actualCost: string,
    surplus: string,
    isOverpaid: boolean,
    traceId: string,
  ): Promise<void> {
    if (!payment?.payerAddress) return;

    const config = getConfig();
    const isEscrowDraw = payment.txHash?.startsWith('escrow:') ?? false;

    // Operational signal (not an error): an escrow-funded request is being
    // served without on-chain settlement, so the prepaid balance is never
    // consumed. This is a deliberate no-op until the flag is enabled.
    if (isEscrowDraw && !config.payment.escrowSettlementEnabled) {
      logger.warn('Escrow-funded request served without escrow settlement enabled', {
        traceId,
        quoteId: payment.quoteId,
        actualCost,
        hint: 'Set ESCROW_SETTLEMENT_ENABLED=true + CONTRACT_ADMIN_SECRET to charge actual usage on-chain',
      });
    }

    settleEscrow({
      enabled: config.payment.escrowSettlementEnabled && isEscrowDraw,
      contractId: config.contracts.creditEscrow,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      adminSecret: config.payment.contractAdminSecret,
      user: payment.payerAddress,
      actualCost,
      surplus,
      isOverpaid,
      quoteId: payment.quoteId,
    })
      // Persist the settlement transactions so the charge and refund are
      // traceable from the database, not only from the gateway log.
      .then((settlement) =>
        this.paymentsService.recordEscrowSettlement(payment.quoteId, settlement),
      )
      .catch((err) => logger.error('Escrow settlement error', { traceId, error: String(err) }));
  }
}

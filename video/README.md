# Pitch video pipeline

This directory produces the project's primary presentation video —
`docs/media/x402-gateway-demo.mp4` — plus its thumbnail and caption track.

Nothing here is part of the product build. It is not an Nx project and adds no
runtime dependency. Nothing large is generated at build time; the rendered
artifacts are committed under `docs/media/`.

```
                ┌──────────────────────┐
 real stack ───►│ video/capture.mjs    │──► video/assets/*.png       (UI, chain, repo)
                └──────────────────────┘    video/assets/live/*.json (real HTTP responses)
                                                      │
                         ┌────────────────────────────┘
                         ▼
                ┌──────────────────────┐
                │ video/render.mjs     │  seeks the deterministic stage
                │  stage + scenes      │  frame by frame → ffmpeg
                └──────────────────────┘──► docs/media/x402-gateway-demo.mp4
                                                      │  (+ .srt, + thumbnail)
                                                      ▼
                ┌──────────────────────┐
                │ make-voiceover.mjs   │  ElevenLabs / OpenAI / Cartesia / Gemini
                └──────────────────────┘  → AAC track → mux
                                        ──► docs/media/x402-gateway-demo-voiced.mp4
```

## Files

| Path                 | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `narration.json`     | **Single source of truth**: scene order, durations, captions, TTS voice   |
| `stage.html`         | 1920×1080 stage shell (fonts, background, caption track)                  |
| `src/ui.js`          | DOM helpers, easing, syntax highlighting, component styles                |
| `src/scenes.js`      | The ten scenes, each driven by scene-local time                           |
| `src/main.js`        | Timeline driver: composites scenes, renders captions, exposes `render(t)` |
| `capture.mjs`        | Captures real UI/chain/repo assets from the running stack                 |
| `seed-demo.sql`      | Idempotent demo dataset for the dashboard screenshots                     |
| `live-payment.mjs`   | Performs a real Stellar testnet payment and records the responses         |
| `render.mjs`         | Frame capture → ffmpeg → MP4, thumbnail and SRT                           |
| `make-voiceover.mjs` | Voiced narration (ElevenLabs/OpenAI/Cartesia/Gemini) + mux                |
| `assets/`            | Captured screenshots and recorded JSON evidence                           |

## Prerequisites

```bash
# system
sudo apt-get install -y ffmpeg fonts-inter fonts-jetbrains-mono

# headless browser, installed out of tree so the repo stays clean
npm install --prefix /tmp/video-tools playwright@1.63.0
npx -y playwright@1.63.0 install --with-deps chromium
```

Playwright is resolved from `PLAYWRIGHT_MODULE`, then a normal install, then
`/tmp/video-tools/node_modules`.

## Regenerating the demo environment

The screenshots come from a **real running stack**, not mock-ups:

```bash
# 1. Postgres + Redis
docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d postgres redis

# 2. Schema + live testnet round trip (writes docs/evidence/testnet-journey.json)
bash scripts/testnet-journey.sh

# 3. Demo dataset for the provider dashboard
docker exec -i x402-journey-pg psql -U x402 -d x402 -v ON_ERROR_STOP=1 < video/seed-demo.sql

# 4. Restart the journey gateway with dashboard CORS + a demo rate limit,
#    then build and start the dashboard against it
#    (see the commands in docs/media notes / git history)

# 5. Capture assets, then render
node video/capture.mjs
node video/render.mjs
```

## Narrating it

The video ships with burned-in captions and an `.srt`. To produce the voiced
version, pick any supported TTS provider — all four return 24 kHz 16-bit mono,
so the mux is identical:

```bash
# validate narration timing without any API call
node video/make-voiceover.mjs --dry-run

# ElevenLabs (default) — https://elevenlabs.io
ELEVENLABS_API_KEY=... node video/make-voiceover.mjs

# or force another provider
OPENAI_API_KEY=...     node video/make-voiceover.mjs --provider openai
CARTESIA_API_KEY=...   node video/make-voiceover.mjs --provider cartesia
GEMINI_API_KEY=...     node video/make-voiceover.mjs --provider gemini
# → docs/media/x402-gateway-demo-voiced.mp4
```

The script measures every generated clip against its scene budget and reports
any overrun instead of silently clipping narration. `narration.json` holds the
provider, voice ids, style prompt and per-scene text, so re-recording is a
config change. Voice ids/models default to a narration-friendly voice per
provider and can be overridden under `voice.providers` in `narration.json`.

## Provenance — what is real and what is demo data

| Asset                                          | Source                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `live/quote-402.json`                          | live HTTP response from the gateway                                                                                              |
| `live/replay-402.json`, `live/forged-402.json` | live rejection responses                                                                                                         |
| `live/live-payment.json`                       | a real Stellar **testnet** payment made by `live-payment.mjs` — including the successful paid retry (`HTTP 200`) and its receipt |
| `live/openapi.json`                            | the gateway's real OpenAPI document (`/api/docs-json`)                                                                           |
| `live/ready.json`, `live/metrics.json`         | live health + Prometheus output                                                                                                  |
| `stellar-expert-tx.png`                        | the real transaction, captured from Stellar Expert                                                                               |
| `repo.png`, `login.png`, `swagger*.png`        | the public repo page and the running dashboard                                                                                   |
| dashboard screenshots                          | the real dashboard, authenticated with a real wallet session                                                                     |
| **dashboard numbers**                          | **seeded demo traffic** from `seed-demo.sql` — not production volume                                                             |

The on-chain evidence for the video is the real payment:
`0d9f98e9fed64409e7abfe471445d257802010603237b287bf2b9ad5f2da18b0`
(ledger 4,652,709, 0.1 USDC, testnet). Its **paid retry returned `HTTP 200`**
with the payment receipt shown in the `live` scene.

## Notes for maintainers

Things found while building this that are worth fixing:

1. **The paid retry now succeeds end to end (fixed).** `POST /chat/completions`
   with a valid `X-Payment-Hash` used to return
   `402 "Payment was made before the quote was issued"`: at retry time
   `verifyAndConfirmPayment` resolved the quote via
   `paymentsService.findByTxHash(txHash)`, but a first-time payment has no
   `Payment` row carrying that hash yet (the quote's row still has
   `txHash = NULL`), so the code minted a **new** quote and validated the
   payment timestamp against it — and a payment made before that new quote was
   always rejected. The quote memo is a deterministic function of the quote id,
   so the gateway now resolves the originating quote from the transaction's
   on-chain memo (`paymentsService.findPendingByQuoteMemo` +
   `x402Service.fetchTransactionMemo`) and binds the payment to the exact quote
   window it paid for. Historical payments with no resolvable quote are still
   rejected by the fresh quote's `issuedAt` lower bound (fail-closed).
   Covered by unit tests (`quoteMemo`/`quoteIdPrefixFromMemo`,
   `findPendingByQuoteMemo`) and two e2e cases; `scripts/testnet-journey.sh`
   now passes its `HTTP 200` step. The video's `live` scene shows the success.
2. **Swagger UI serves a blank page.** `/api/docs` returns a shell whose
   relative assets (`./docs/swagger-ui-bundle.js`, `./docs/swagger-ui.css`)
   resolve to `/api/docs/…` and 404. The OpenAPI document itself is fine at
   `/api/docs-json`, which is what the video's API-surface figures use.

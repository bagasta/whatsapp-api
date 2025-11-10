## WhatsApp Multi-Tenant API

Production-ready REST API for managing multi-tenant WhatsApp Web sessions, forwarding inbound messages to an AI backend, and exposing direct messaging endpoints.

### Stack
- Node.js 18+ with Express single-process runtime (PM2 friendly)
- whatsapp-web.js (LocalAuth per agent)
- PostgreSQL via `pg`
- Structured logging with Pino
- `prom-client` metrics (`/metrics`)

### Prerequisites
1. Node.js 18+ and npm
2. Google Chrome/Chromium (required by `whatsapp-web.js`)
3. PostgreSQL database with shared `api_keys` table (managed elsewhere) and `whatsapp_user` table (owned by this service)

### Getting Started
```bash
cp .env.example .env
npm install
npm run dev
```

Update `.env` with your DB URL, AI backend, temp directories, and CORS origins. The service binds to `PORT` (default 3000).

### Database Setup (Prisma)
`prisma/schema.prisma` now contains only the WhatsApp-specific `whatsapp_user` model. The shared `api_keys` table is intentionally left out so Prisma migrations cannot modify it. After configuring `DB_URL`, run:
```bash
npm run prisma:generate     # optional – regenerates Prisma client
npm run prisma:push         # creates/updates the tables in your database
# or, if you prefer migrations:
npm run prisma:migrate
```
This ensures the columns (`api_key`, `agent_id`, etc.) match what the service queries.

### Environment Variables
| Name | Description |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `APP_BASE_URL` | Public base URL for clients |
| `AI_BACKEND_URL` | Default AI proxy base (fallback when DB endpoint missing) |
| `CORS_ORIGINS` | Comma-separated list of allowed origins |
| `TEMP_DIR` | Path for media previews & cleanup job |
| `WWEBJS_AUTH_DIR` | LocalAuth store (per agent subdir) |
| `DB_URL` | PostgreSQL connection string |
| `LOG_LEVEL` | Pino log level (`info`, `debug`, etc.) |

### Project Layout
```
/src
  /config/env.js           # env loader + defaults
  /middleware/authMiddleware.js
  /routes/*.js             # sessions, agents, health/metrics
  /services/
    whatsappClientManager.js
    aiProxy.js
    rateLimiter.js
    cleanupJob.js
  /utils/
    db.js, logger.js, metrics.js, jid.js, responses.js, errorMapping.js
app.js                     # Express bootstrap + dependency wiring
openapi.yaml/json          # OpenAPI 3.0 specs
```

### Key Features
- Multi-tenant WhatsApp sessions (LocalAuth per `agentId`)
- Session lifecycle endpoints (create, status, delete, reconnect)
- Automatic inbound forwarding: filters statuses/channels, enforces group mention requirement, shows typing indicator, and notifies developer number on AI failures
- AI proxy with 60s timeout and DB endpoint override
- `endpoint_url_run` auto-seeded to `${AI_BACKEND_URL}/agents/{agentId}/execute` when sessions are created
- Direct messaging endpoints for text & images (base64 or URL with pre-download size validation)
- Token-bucket + FIFO queue rate limiter (100 msg/min burst, queue depth 500)
- Phone/JID normalization helper
- JSON-lines logging enriched with `traceId` & `agentId`
- Prometheus metrics (`/metrics`) + `/health`

### Example Requests
Replace `AGENT_ID` and `API_KEY` with actual values.

#### Create Session
```bash
curl -X POST http://localhost:3000/sessions \
  -H 'Content-Type: application/json' \
  -d '{"userId":"ff2c9e4b-94fd-4120-9d95-cb4d9bac3a4c","agentId":"support-bot","agentName":"Support Bot","apikey":"api-key"}'
```
Gunakan endpoint QR (lihat di bawah) untuk mengambil QR base64 setelah sesi dibuat.

#### Get Session Status
```bash
curl http://localhost:3000/sessions/support-bot
```
Respon `liveState.qr` pada endpoint status akan terisi setelah QR digenerate melalui endpoint khusus di bawah, dan memiliki struktur `{ "contentType": "image/png", "base64": "..." }`.

#### Generate QR
```bash
curl -X POST http://localhost:3000/sessions/support-bot/qr
```
Endpoint ini memaksa WhatsApp client menghasilkan QR dan menunggu hingga QR tersedia (maks 60 detik). Respons `data.qr` memiliki struktur:
```json
{
  "contentType": "image/png",
  "base64": "iVBORw0KGgoAAAANSUhEUg..."
}
```
Gunakan nilai `base64` untuk membuat file PNG, sementara `contentType` bisa menjadi referensi MIME.

#### Delete Session
```bash
curl -X DELETE http://localhost:3000/sessions/support-bot
```

#### Force Reconnect
```bash
curl -X POST http://localhost:3000/sessions/support-bot/reconnect
```

#### Run AI Pipeline
```bash
curl -X POST http://localhost:3000/agents/support-bot/run \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer API_KEY' \
  -d '{
    "input": "Hello assistant!",
    "parameters": { "max_steps": 5 },
    "session_id": "6281234567890"
  }'
```

#### Send Text Message
```bash
curl -X POST http://localhost:3000/agents/support-bot/messages \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer API_KEY' \
  -d '{"to":"6281234567890","message":"Halo dari API"}'
```

#### Send Media (Base64)
```bash
curl -X POST http://localhost:3000/agents/support-bot/media \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer API_KEY' \
  -d '{"to":"6281234567890","caption":"Sample","data":"<base64>","filename":"sample.jpg","mimeType":"image/jpeg"}'
```

#### Send Media (URL)
```bash
curl -X POST http://localhost:3000/agents/support-bot/media \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer API_KEY' \
  -d '{"to":"6281234567890","url":"https://example.com/image.jpg"}'
```

#### Health & Metrics
```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

### Observability
- **Logs**: JSON lines via Pino, automatically capturing `traceId`, `agentId`, and event names
- **Metrics**: `whatsapp_sessions_active`, `whatsapp_messages_sent_total`, `whatsapp_messages_received_total`, `whatsapp_errors_total`, `whatsapp_ai_latency_seconds`

### Notes
- Cleanup job trims preview files older than 24h every 30 minutes.
- LocalAuth directories live under `WWEBJS_AUTH_DIR/session-<agentId>`.
- `/sessions/*` endpoints are intentionally unauthenticated (per PRD); agent endpoints enforce Bearer auth with lazy API-key sync.
- The service is single-process by design and ready for PM2 supervision.

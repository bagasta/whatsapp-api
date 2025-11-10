# PRD — WhatsApp API (whatsapp-web.js + Express)
Owner: Bagas Tri Adiwira • Date: 2025-11-07 • Port: 3000

## 0) Ringkasan
Layanan REST untuk:
- Mengelola sesi WhatsApp Web per `agentId` (multi-tenant per `userId`).
- Meneruskan pesan masuk ke AI backend (webhook-free) dan mengirim balasan ke WhatsApp.
- Menyediakan endpoint langsung untuk kirim teks & media (image only) dengan autentikasi Bearer.
- Observability: `/health` + `/metrics` (Prometheus), logging JSON Lines per baris.

## 1) Scope & Non-Goals
### Scope
- Sesi WA per `agentId` (LocalAuth), 1 proses (pm2) menangani banyak agent.
- Create/Delete/Status/Reconnect sesi.
- Kirim pesan teks & media (image only).
- Endpoint AI forwarding `/agents/{agentId}/run` dengan typing indicator.
- Filtering inbound: abaikan status, channel, dan group tanpa mention (mention = nomor bot).
- Normalisasi nomor ke JID (`628…@c.us` / `…@g.us`).
- Rate limit per agent + queue.
- File temp: `/tmp/wwebjs` + cleanup >24 jam tiap 30 menit.
- CORS via ENV.

### Non-Goals (saat ini)
- Template messages, interactive buttons.
- Multi-process clustering & Docker (akan pakai pm2 single process).
- Voice note & image → AI (next phase).

## 2) Port, Base URL, ENV
- **PORT**: 3000
- **APP_BASE_URL**: base untuk compose endpoint di response.
- **AI_BACKEND_URL**: base URL downstream; detail endpoint prioritas dari DB.
- **CORS_ORIGINS**: daftar origin dipisah koma.
- **TEMP_DIR**: default `/tmp/wwebjs`.
- **WWEBJS_AUTH_DIR**: opsional (default `.wwebjs_auth` di working dir).
- **DB_URL**: koneksi Postgres.

## 3) Data Model
### 3.1 Tabel: dev_ai.public.api_keys
- Sumber API key; pilih `is_active = true` untuk “latest active”.

### 3.2 Tabel: dev_ai.public.whatsapp_user
```sql
create table if not exists dev_ai.public.whatsapp_user (
  user_id int not null,
  agent_id text not null,
  agent_name text not null,
  api_key text not null,
  endpoint_url_run text,
  status text not null, -- awaiting_qr | connected | disconnected | auth_failed
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, agent_id)
);
```

## 4) Autentikasi
- `Authorization: Bearer <api_key>` **wajib** untuk:
  - `/agents/{agentId}/run`
  - `/agents/{agentId}/messages`
  - `/agents/{agentId}/media`
- Kecocokan dilakukan terhadap `whatsapp_user.api_key` (bukan “latest active”). Jika mismatch:
  - **Respon**: `401 Unauthorized`.
  - **Lazy update**: background task sinkronkan `whatsapp_user.api_key` ke “latest active” dari `dev_ai.public.api_keys` (jika ada).

`/sessions*` tidak butuh auth.

## 5) Normalisasi Nomor & JID
- Terima input: `08xx`, `+628xx`, `628xx`, `…@c.us`, `…@g.us`.
- Standarkan ke JID: `628…@c.us` (user) dan `…@g.us` (group).
- `/agents/{agentId}/run` menerima `sessionId` (boleh bare number); akan dikonversi ke JID.

## 6) Lifecycle Sesi
Status: `awaiting_qr | connected | disconnected | auth_failed`.
- **Create Session (POST /sessions)**:
  - Ambil latest active API key dari `dev_ai.public.api_keys` (`is_active = true`) untuk `userId`.
  - Jika `agentId` sudah **connected** → `200` tanpa `qr`.
  - Jika ada record lama tapi tidak ready → hapus record & inisialisasi ulang.
  - LocalAuth per `agentId` (`.wwebjs_auth/<agentId>`). QR mengikuti siklus WhatsApp (auto refresh).

- **Delete Session (DELETE /sessions/{agentId})**: logout & hapus auth files + record DB.

- **Status (GET /sessions/{agentId})**: mengembalikan status persist + live (isConnected, sessionState, isReady, hasClient).

- **Reconnect (POST /sessions/{agentId}/reconnect)**: logout → init baru → kirim QR (anytime).

## 7) Inbound Message Flow (webhook-free)
- Abaikan: status/stories, channel, dan group **tanpa** mention nomor bot.
- DM (private) selalu diproses.
- Hanya **text** yang diteruskan ke AI untuk saat ini.
- Deteksi mention di grup: `message.mentionedIds` mengandung nomor bot **atau** body menyebut nomor bot `62xxxxxxxxxx`.
- Payload AI: sama seperti `/agents/{agentId}/run` (lihat §8).
- Tampilkan typing indicator selama menunggu AI. Jika timeout/error:
  - Matikan typing.
  - **Tidak** membalas ke user.
  - Kirim laporan fallback ke developer **62895619356936** berisi: agentId, from, text, reason (TIMEOUT/ERROR), traceId, timestamp.

## 8) Outbound ke AI Backend
- Endpoint: prioritas **DB `endpoint_url_run`**; fallback `${AI_BACKEND_URL}/agents/{agentId}/run`.
- Header: `Authorization: Bearer <api_key>` (dari `whatsapp_user`).
- Timeout: 60 detik untuk AI response.
- Bentuk balikan minimal yang diproses: `{ "reply": "..." }`.
- Jika ada `reply`: kirim ke `sessionId` (JID) dan return `replySent: true`.

## 9) Rate Limit & Queue
- Per **agent**: token-bucket **100 msg/menit**, burst 100.
- Queue per agent: **maks 500** pesan. Jika penuh → `429` `{ "error": { "code":"RATE_LIMITED", ... } }`.
- Pengiriman dequeues FIFO; aman untuk WA (hindari spike).

## 10) Media
- Endpoint `/agents/{agentId}/media`: **image only**, max **10MB**.
- Sumber `data` (base64) **atau** `url`. Jika `url` > 10MB → `413 Payload Too Large`.
- Default simpan ke `${TEMP_DIR}` (previewPath) lalu **hapus otomatis** >24 jam (cleanup tiap 30 menit). `save_to_temp=false` → tidak ada previewPath.

## 11) Observability
- `/health`: `{ status, uptime, timestamp }`.
- `/metrics`: Prometheus tanpa auth (bisa dibatasi reverse proxy).
- Log: JSON Lines per baris (pino), setiap entri memuat `agentId` jika relevan, `traceId`, level, event.

## 12) Error Contract (ringkas)
Semua error 4xx/5xx:
```json
{ "error": { "code": "STRING_CODE", "message": "Human readable message", "traceId": "..." } }
```
Contoh code: `UNAUTHORIZED`, `INVALID_PAYLOAD`, `SESSION_NOT_FOUND`, `SESSION_NOT_READY`, `RATE_LIMITED`, `AI_TIMEOUT`, `AI_DOWNSTREAM_ERROR`, `MEDIA_TOO_LARGE`, `BAD_GATEWAY`.

## 13) Endpoint Ringkas
- `POST /sessions` — create/rehydrate session + kemungkinan QR.
- `DELETE /sessions/{agentId}` — hapus sesi & auth.
- `GET /sessions/{agentId}` — status.
- `POST /sessions/{agentId}/reconnect` — re-init + QR.
- `POST /agents/{agentId}/run` — forward ke AI + auto-reply ke WA. (Bearer)
- `POST /agents/{agentId}/messages` — kirim teks; dukung group & quoted reply. (Bearer)
- `POST /agents/{agentId}/media` — kirim image. (Bearer)
- `GET /health`, `GET /metrics`.

## 14) Contoh Payload
### 14.1 Create Session
```json
{ "userId": 123, "agentId": "support-bot", "agentName": "Support Bot", "apikey": "xxx" }
```
**Catatan**: `apikey` di body dipakai hanya bila DB belum memiliki key aktif; jika ada, layanan mengambil **latest active** dari `dev_ai.public.api_keys`.

### 14.2 Run (AI)
```json
{
  "message": "Hello assistant!",
  "sessionId": "6281234567890@c.us",
  "openai_api_key": "sk-... (opsional)",
  "memory_enable": true,
  "context_memory": "100",
  "rag_enable": true,
  "metadata": { "whatsapp_name":"Customer", "chat_name":"VIP Support" }
}
```

### 14.3 Kirim Pesan
```json
{ "to": "6281234567890", "message": "Halo dari API" }
```
Quoted reply:
```json
{ "to": "6281234567890", "message": "Noted", "quoteId": "true_628...@c.us_XXXX" }
```

### 14.4 Kirim Media (image only)
```json
{
  "to":"6281234567890",
  "data":"BASE64_IMAGE",
  "caption":"Invoice #123",
  "mimetype":"image/jpeg"
}
```

## 15) Pseudo Kode Arsitektur (ringkas & efisien)
- **app.js**: bootstrap Express, CORS, routes, error handler, pino logger, prom-client.
- **whatsappClientManager.js**: Map<agentId, client>; init, reconnect, destroy; event → update DB; helper sendText/sendImage.
- **authMiddleware.js**: cek Bearer vs `whatsapp_user.api_key`; jika mismatch → 401 + trigger async lazy update.
- **jid.js**: normalisasi nomor ke JID.
- **rateLimiter.js**: token-bucket per agent + queue FIFO.
- **cleanupJob.js**: hapus file >24h di `${TEMP_DIR}` tiap 30 menit.
- **aiProxy.js**: resolve endpoint (DB > ENV), call dengan timeout 60s, parse `{reply}`.

## 16) Kualitas Kode
- Clean code: modular, SRP, komentar jelas di tiap fungsi.
- Efisien: satu proses, in-memory map untuk rate-limit & client pool.
- Dokumentasi: README, cURL, OpenAPI (YAML+JSON).

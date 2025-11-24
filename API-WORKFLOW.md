# Alur Kerja WhatsApp API

Dokumen ini menjabarkan alur kerja end-to-end untuk setiap endpoint, interaksi database, serta integrasi eksternal (WhatsApp Web, AI backend, observability).

## Gambaran Arsitektur
- **app.js** mem-boot Express, menempelkan middleware `traceId`, logging Pino, CORS/Helmet/body parser, lalu memasang rute `/sessions`, `/agents`, dan `/health`/`/metrics`.
- **WhatsappClientManager** menyimpan sesi WA per `agentId` di memori (`Map`), menangani lifecycle client `whatsapp-web.js`, QR, pengiriman pesan, rate limiting, dan forwarding inbound ke AI.
- **RateLimiter** (token bucket 100 msg/menit, burst 100, antrean 500) membungkus semua pengiriman pesan/AI call per agent.
- **aiProxy** memanggil AI backend dengan Bearer token dari DB/ENV; timeout 60 detik; hanya `reply` yang dipakai untuk dikirimkan ke WA.
- **cleanupJob** menjaga direktori temp (preview media) dengan menghapus file >24 jam tiap 30 menit.

## Model Data & Storage
- **Tabel `whatsapp_user`** (dimiliki layanan ini) – kolom utama: `user_id`, `agent_id`, `agent_name`, `api_key`, `endpoint_url_run`, `status`, `last_connected_at`, `last_disconnected_at`, `created_at`, `updated_at`. Primary key: `(user_id, agent_id)`.
- **Tabel `api_keys`** (shared) – hanya dibaca untuk mengambil `access_token` terbaru dengan `is_active = true` per `user_id` ketika membuat/menyinkronkan sesi.
- **LocalAuth WhatsApp** – folder `WWEBJS_AUTH_DIR/session-<agentId>` untuk persist auth per agent.
- **File preview media** – disimpan di `TEMP_DIR` kecuali `save_to_temp=false`; dibersihkan otomatis oleh cleanup job.

## Integrasi Eksternal
- **WhatsApp Web (whatsapp-web.js)**: LocalAuth headless; event `qr`, `ready`, `auth_failure`, `disconnected`, `message` di-handle untuk memperbarui status DB, mengirim QR, dan mem-forward pesan.
- **AI Backend**: endpoint prioritas `whatsapp_user.endpoint_url_run`, fallback `${AI_BACKEND_URL}/agents/{agentId}/execute`; header `Authorization: Bearer <api_key>`; timeout 60s; hanya string reply yang dikirimkan kembali ke WA.
- **Observability**: `/health` JSON sederhana; `/metrics` Prometheus (`sessions_active`, `messages_sent_total`, `messages_received_total`, `errors_total`, `ai_latency_seconds`); logging Pino dengan `traceId` + `agentId`.
- **Developer alert**: kegagalan inbound→AI akan dilaporkan ke nomor developer (`env.developerJid`) via WhatsApp.

## Alur Per Endpoint

### 1) POST `/sessions`
1. Validasi body: `userId`, `agentId`, `agentName` wajib; `apikey` opsional.
2. **Upsert DB** (`WhatsappClientManager.upsertAgentRecord`):
   - Cari API key aktif di `api_keys` untuk `userId`; jika tidak ada, pakai `apikey` yang dikirim.
   - Jika record ada: perbarui `agent_name`, `api_key`, `endpoint_url_run` (default `${AI_BACKEND_URL}/agents/{agentId}/execute`), `updated_at`.
   - Jika belum ada: insert dengan `status=awaiting_qr`.
3. **Ensure client**: inisialisasi `whatsapp-web.js` dengan LocalAuth `session-<agentId>` + event listener.
4. **QR handling**: jika `liveState` belum siap dan belum ada QR, rute memanggil `generateQr` untuk menunggu QR dan menambahkannya ke respons.
5. Respons berisi data persist + `liveState` (isReady, sessionState, qr, timestamps).

Contoh `curl`:
```bash
curl -X POST "$BASE_URL/sessions" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_ID",
    "agentId": "AGENT_ID",
    "agentName": "Support Bot",
    "apikey": "API_KEY_JIKA_DB_KOSONG"
  }'
```

### 2) GET `/sessions/{agentId}`
1. Ambil record `whatsapp_user`; jika tidak ada → `404 SESSION_NOT_FOUND`.
2. Susun payload status gabungan persist + live session (isReady, hasClient, sessionState, QR jika sudah ada di memori).

Contoh `curl`:
```bash
curl "$BASE_URL/sessions/AGENT_ID"
```

### 3) DELETE `/sessions/{agentId}`
1. Jika client ada: destroy client, kurangi metric, opsional hapus auth files.
2. Hapus record `whatsapp_user`; jika sudah tidak ada tetap `200` dengan `deleted: false`.

Contoh `curl`:
```bash
curl -X DELETE "$BASE_URL/sessions/AGENT_ID"
```

### 4) POST `/sessions/{agentId}/reconnect`
1. Validasi agent ada (`404` jika tidak).
2. Destroy client (preserve DB, clear auth), lalu inisialisasi ulang client dan status; respons sama seperti create.

Contoh `curl`:
```bash
curl -X POST "$BASE_URL/sessions/AGENT_ID/reconnect"
```

### 5) POST `/sessions/{agentId}/qr`
1. Pastikan sesi/record ada.
2. Pastikan client aktif; tunggu event QR (`waitForQr`, timeout 60s).
3. Balikkan `{ qr: { contentType, base64 }, qrUpdatedAt }`.

Contoh `curl`:
```bash
curl -X POST "$BASE_URL/sessions/AGENT_ID/qr"
```

### 6) POST `/agents/{agentId}/run`
1. **Auth Bearer**: `authMiddleware` cek token vs `whatsapp_user.api_key`; jika mismatch → `401` dan trigger sinkronisasi async ke `api_keys`.
2. Validasi body: `input`/`message` wajib, `session_id` wajib → dinormalisasi ke JID (`normalizeJid`), `parameters` default `{ max_steps: 5 }`.
3. **Call AI** (`aiProxy.executeRun`): POST ke endpoint, header Bearer; timeout 60s; parse reply string.
4. Jika ada `reply` → kirim via `manager.sendText` ke JID (rate limited).
5. Respons `{ reply, replySent }` + `traceId`. Error dipetakan ke kode (`AI_TIMEOUT`, `AI_DOWNSTREAM_ERROR`, dll).

Contoh `curl`:
```bash
curl -X POST "$BASE_URL/agents/AGENT_ID/run" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{
    "input": "Hello assistant!",
    "parameters": { "max_steps": 5 },
    "session_id": "6281234567890"
  }'
```

### 7) POST `/agents/{agentId}/messages`
1. **Auth Bearer** seperti di atas.
2. Validasi `to` dan `message`; `quotedMessageId` opsional.
3. `sendText`:
   - Pastikan record/sesi ada & `isReady`; jika tidak → `404`/`409`.
   - Normalisasi JID penerima; kirim `sendMessage` dengan quoted reply jika ada; tercatat ke metric.
4. Respons `{ delivered: true }`.

Contoh `curl`:
```bash
curl -X POST "$BASE_URL/agents/AGENT_ID/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{
    "to": "6281234567890",
    "message": "Halo dari API",
    "quotedMessageId": "opsional_true_628...@c.us_XXXX"
  }'
```

### 8) POST `/agents/{agentId}/media`
1. **Auth Bearer** seperti di atas.
2. Validasi `to` serta salah satu `data` (base64) atau `url`.
3. `prepareMedia`:
   - Jika base64: cek ukuran ≤10MB.
   - Jika URL: HEAD untuk `content-length` ≤10MB, GET arraybuffer, turunkan `mimeType`/`filename` bila tersedia.
   - Buat `MessageMedia`; simpan preview di `TEMP_DIR` (kecuali `save_to_temp=false`).
4. Kirim media via `sendMessage` (rate limited). Respons `{ delivered: true, previewPath }`.

Contoh `curl` (base64):
```bash
curl -X POST "$BASE_URL/agents/AGENT_ID/media" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{
    "to": "6281234567890",
    "data": "<BASE64_IMAGE>",
    "caption": "Invoice #123",
    "filename": "invoice.jpg",
    "mimeType": "image/jpeg"
  }'
```

Contoh `curl` (URL):
```bash
curl -X POST "$BASE_URL/agents/AGENT_ID/media" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer API_KEY" \
  -d '{
    "to": "6281234567890",
    "url": "https://example.com/image.jpg",
    "caption": "From URL"
  }'
```

### 9) GET `/health` dan GET `/metrics`
- `/health`: laporan statis (`status`, `uptime`, `timestamp`, `traceId`).
- `/metrics`: ekspor seluruh Prometheus registry; tanpa auth (atur di reverse proxy jika perlu).

Contoh `curl`:
```bash
curl "$BASE_URL/health"
curl "$BASE_URL/metrics"
```

## Alur Inbound (Otomatis, Tanpa Endpoint)
1. Event `message` dari `whatsapp-web.js`:
   - Abaikan status/stories/channel dan pesan dari bot sendiri.
   - Jika grup (`@g.us`): lanjut hanya bila bot dimention (`mentionedIds`) atau nomor bot muncul di isi pesan.
   - Hanya tipe `chat` (teks) yang diproses.
2. Normalisasi payload AI (`input` = teks, `session_id` = pengirim JID, metadata nama WA/chat).
3. Kirim typing indicator, enqueue AI call -> kirim reply jika ada; bersihkan typing.
4. Jika error/timeout: hentikan typing, laporkan ke `developerJid` dengan detail agent/from/reason/trace.

## Status & Error Handling
- Status sesi: `awaiting_qr`, `connected`, `disconnected`, `auth_failed` (persist di DB + live di memori).
- Error standar: `{ "error": { "code", "message", "traceId" } }` dengan kode seperti `INVALID_PAYLOAD`, `UNAUTHORIZED`, `SESSION_NOT_FOUND`, `SESSION_NOT_READY`, `RATE_LIMITED`, `MEDIA_TOO_LARGE`, `AI_TIMEOUT`, `AI_DOWNSTREAM_ERROR`, `BAD_GATEWAY`.

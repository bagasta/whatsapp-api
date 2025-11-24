const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { query } = require('../utils/db');
const { normalizeJid } = require('../utils/jid');
const { buildAgentEndpoint } = require('../utils/aiEndpoint');
const aiProxy = require('./aiProxy');
const { RateLimitError } = require('./rateLimiter');

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const sessionAuthPath = (agentId) => path.join(env.wwebAuthDir, `session-${agentId}`);

const buildStatusPayload = (agentRecord, session) => ({
  agentId: agentRecord.agent_id,
  agentName: agentRecord.agent_name,
  status: agentRecord.status,
  lastConnectedAt: agentRecord.last_connected_at,
  lastDisconnectedAt: agentRecord.last_disconnected_at,
  createdAt: agentRecord.created_at,
  updatedAt: agentRecord.updated_at,
  liveState: {
    isReady: session?.isReady || false,
    hasClient: Boolean(session?.client),
    sessionState: session?.status || agentRecord.status,
    qr: session?.qr || null,
    qrUpdatedAt: session?.qrUpdatedAt || null,
  },
});

class WhatsappClientManager {
  constructor({ rateLimiter }) {
    this.sessions = new Map();
    this.rateLimiter = rateLimiter;
    this.readyPromises = new Map();
    this.reconnectTimers = new Map();
  }

  async bootstrapPersistedSessions() {
    try {
      const result = await query(
        `
          select *
          from whatsapp_user
          where status in ('connected', 'awaiting_qr', 'disconnected')
        `,
      );
      await Promise.all(
        result.rows.map(async (record) => {
          try {
            await this.ensureClient(record);
          } catch (error) {
            logger.error({ err: error, agentId: record.agent_id, event: 'session.bootstrap.error' }, 'Failed bootstrapping session');
          }
        }),
      );
      logger.info({ event: 'session.bootstrap.complete', count: result.rows.length }, 'Bootstrapped persisted sessions');
    } catch (error) {
      logger.error({ err: error, event: 'session.bootstrap.failed' }, 'Failed loading persisted sessions');
    }
  }

  async createOrResumeSession({ userId, agentId, agentName, apiKey }) {
    const agentRecord = await this.upsertAgentRecord({ userId, agentId, agentName, apiKey });
    await this.ensureClient(agentRecord);
    return this.buildResponse(agentRecord);
  }

  async reconnect(agentId) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    await this.teardownClient(agentId, { preserveDb: true, clearAuth: true });
    await this.ensureClient(agentRecord);
    return this.buildResponse(agentRecord);
  }

  async deleteSession(agentId) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      await this.teardownClient(agentId, { preserveDb: true, clearAuth: true });
      return { deleted: false, alreadyRemoved: true };
    }
    await this.teardownClient(agentId, { preserveDb: false, clearAuth: true });
    await query('delete from whatsapp_user where user_id = $1 and agent_id = $2', [
      agentRecord.user_id,
      agentRecord.agent_id,
    ]);
    return { deleted: true };
  }

  async getStatus(agentId) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    return this.buildResponse(agentRecord);
  }

  async generateQr(agentId) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    await this.ensureClient(agentRecord);
    const qr = (await this.waitForQr(agentId)) || null;
    const session = this.sessions.get(agentId);
    return {
      agentId,
      qr,
      qrUpdatedAt: session?.qrUpdatedAt || null,
    };
  }

  async sendText(agentId, payload) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    const session = await this.ensureClient(agentRecord);
    if (!session.isReady) {
      const error = new Error('Session not ready');
      error.code = 'SESSION_NOT_READY';
      throw error;
    }

    const to = normalizeJid(payload.to);
    const options = {};
    if (payload.quotedMessageId) {
      options.quotedMessageId = payload.quotedMessageId;
    }

    await this.rateLimiter.enqueue(agentId, async () => session.client.sendMessage(to, payload.message, options));
    metrics.messagesSent.inc({ agentId });
    return { delivered: true };
  }

  async sendMedia(agentId, data) {
    const agentRecord = await this.getAgent(agentId);
    if (!agentRecord) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    const session = await this.ensureClient(agentRecord);
    if (!session.isReady) {
      const error = new Error('Session not ready');
      error.code = 'SESSION_NOT_READY';
      throw error;
    }

    const media = await this.prepareMedia(data);
    const to = normalizeJid(data.to);
    await this.rateLimiter.enqueue(agentId, async () =>
      session.client.sendMessage(to, media.media, { caption: data.caption || '' }),
    );
    metrics.messagesSent.inc({ agentId });
    return { delivered: true, previewPath: media.previewPath };
  }

  async prepareMedia({ data, url, filename = 'image.jpg', mimeType = 'image/jpeg', save_to_temp = true }) {
    let buffer;
    if (data) {
      const base64 = data.includes(',') ? data.split(',').pop() : data;
      buffer = Buffer.from(base64, 'base64');
      if (buffer.length > MAX_MEDIA_BYTES) {
        const error = new Error('Media exceeds 10MB');
        error.code = 'MEDIA_TOO_LARGE';
        throw error;
      }
    } else if (url) {
      let head;
      try {
        head = await axios.head(url);
      } catch (error) {
        const err = new Error('Failed to inspect remote media');
        err.code = 'BAD_GATEWAY';
        throw err;
      }
      const size = Number(head.headers['content-length']);
      if (!size || Number.isNaN(size) || size > MAX_MEDIA_BYTES) {
        const error = new Error('Remote media exceeds 10MB or size unknown');
        error.code = 'MEDIA_TOO_LARGE';
        throw error;
      }

      const response = await axios.get(url, { responseType: 'arraybuffer' });
      buffer = Buffer.from(response.data);
      mimeType = response.headers['content-type'] || mimeType;
      if (!filename) {
        try {
          const pathname = new URL(url).pathname;
          filename = path.basename(pathname);
        } catch (error) {
          filename = 'image.jpg';
        }
      }
    } else {
      const error = new Error('Either data or url is required');
      error.code = 'INVALID_PAYLOAD';
      throw error;
    }

    const messageMedia = new MessageMedia(mimeType, buffer.toString('base64'), filename);
    let previewPath = null;
    if (save_to_temp !== false) {
      await ensureDir(env.tempDir);
      previewPath = path.join(env.tempDir, `${Date.now()}-${filename}`);
      await fs.writeFile(previewPath, buffer);
    }

    return { media: messageMedia, previewPath };
  }

  async ensureClient(agentRecord) {
    if (this.sessions.has(agentRecord.agent_id)) {
      const existing = this.sessions.get(agentRecord.agent_id);
      existing.agent = agentRecord;
      existing.lastAgentRefresh = Date.now();
      return existing;
    }

    await ensureDir(env.wwebAuthDir);

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: agentRecord.agent_id,
        dataPath: env.wwebAuthDir,
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    const session = {
      agent: agentRecord,
      client,
      qr: null,
      qrUpdatedAt: null,
      isReady: false,
      status: agentRecord.status,
      lastAgentRefresh: Date.now(),
      shuttingDown: false,
    };
    this.sessions.set(agentRecord.agent_id, session);

    client.on('qr', async (qr) => {
      let encoded;
      try {
        const dataUrl = await QRCode.toDataURL(qr, {
          type: 'image/png',
          errorCorrectionLevel: 'M',
          margin: 2,
        });
        const base64 = dataUrl.split(',')[1];
        encoded = {
          contentType: 'image/png',
          base64,
        };
        session.qr = encoded;
      } catch (error) {
        logger.error({ err: error, agentId: agentRecord.agent_id, event: 'session.qr.encode' }, 'Failed encoding QR');
        encoded = null;
      }
      session.qrUpdatedAt = new Date().toISOString();
      session.status = 'awaiting_qr';
      await this.updateStatus(agentRecord, 'awaiting_qr');
      const pending = this.readyPromises.get(agentRecord.agent_id);
      if (pending) {
        this.readyPromises.delete(agentRecord.agent_id);
        pending.resolve(encoded);
      }
      logger.info({ agentId: agentRecord.agent_id, event: 'session.qr' }, 'QR code generated');
    });

    client.on('ready', async () => {
      session.isReady = true;
      session.status = 'connected';
      if (!session.metricsCounted) {
        metrics.sessionsActive.inc();
        session.metricsCounted = true;
      }
      await this.updateStatus(agentRecord, 'connected', { last_connected_at: 'now()' });
      logger.info({ agentId: agentRecord.agent_id, event: 'session.ready' }, 'Session ready');
    });

    client.on('auth_failure', async (msg) => {
      if (session.shuttingDown) {
        return;
      }
      session.status = 'auth_failed';
      session.isReady = false;
      await this.updateStatus(agentRecord, 'auth_failed', { last_disconnected_at: 'now()' });
      logger.error({ agentId: agentRecord.agent_id, event: 'session.auth_failure', msg }, 'Auth failure');
      this.scheduleSessionRestart(agentRecord, { reason: 'auth_failure', clearAuth: true });
    });

    client.on('disconnected', async (reason) => {
      if (session.shuttingDown) {
        return;
      }
      session.status = 'disconnected';
      session.isReady = false;
      if (session.metricsCounted) {
        metrics.sessionsActive.dec();
        session.metricsCounted = false;
      }
      await this.updateStatus(agentRecord, 'disconnected', { last_disconnected_at: 'now()' });
      logger.warn({ agentId: agentRecord.agent_id, event: 'session.disconnected', reason }, 'Session disconnected');
      const clearAuth = typeof reason === 'string' && reason.toLowerCase().includes('logout');
      this.scheduleSessionRestart(agentRecord, { reason: reason || 'disconnected', clearAuth });
    });

    client.on('message', (message) => this.handleInboundMessage({ session, message }));

    client.initialize().catch((error) => {
      logger.error({ err: error, agentId: agentRecord.agent_id }, 'Failed initializing WhatsApp client');
    });

    return session;
  }

  async handleInboundMessage({ session, message }) {
    try {
      if (message.fromMe || message.isStatus || message.broadcast || message.isBroadcast) {
        return;
      }

      await this.refreshAgentRecord(session);
      const agentId = session.agent.agent_id;

      const botJid = session.client.info?.wid?._serialized;
      const botDigits = botJid ? botJid.replace('@c.us', '').replace(/\D/g, '') : null;

      if (message.from.endsWith('@g.us')) {
        const mentioned = botJid ? message.mentionedIds?.includes(botJid) : false;
        const bodyDigits = message.body ? message.body.replace(/\D/g, '') : '';
        const bodyContains = botDigits ? bodyDigits.includes(botDigits) : false;
        if (!mentioned && !bodyContains) {
          return;
        }
      }

      if (message.type !== 'chat') {
        return;
      }

      metrics.messagesReceived.inc({ agentId });
      const traceId = randomUUID();
      const payload = {
        input: message.body,
        parameters: {
          max_steps: 5,
          metadata: {
            whatsapp_name: message._data?.notifyName,
            chat_name: message._data?.sender?.pushname,
          },
        },
        session_id: message.from,
      };

      await this.rateLimiter.enqueue(agentId, async () => {
        let chat;
        try {
          chat = await message.getChat();
          await chat.sendStateTyping();
          const { reply } = await aiProxy.executeRun({ agentRecord: session.agent, payload, traceId });
          await chat.clearState().catch(() => {});
          if (reply) {
            await session.client.sendMessage(message.from, reply);
            metrics.messagesSent.inc({ agentId });
          }
        } catch (error) {
          if (chat) {
            await chat.clearState().catch(() => {});
          }
          await this.reportInboundError({ session, message, error, traceId });
        }
      });
    } catch (error) {
      logger.error({ err: error, event: 'inbound.unhandled' }, 'Unhandled inbound handler error');
    }
  }

  async reportInboundError({ session, message, error, traceId }) {
    const reason = error.code || 'ERROR';
    const report = [
      `Agent: ${session.agent.agent_id}`,
      `From: ${message.from}`,
      `Reason: ${reason}`,
      `Trace: ${traceId}`,
      `Body: ${message.body}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');
    try {
      await this.rateLimiter.enqueue(session.agent.agent_id, async () =>
        session.client.sendMessage(env.developerJid, report),
      );
    } catch (err) {
      logger.error({ err, event: 'inbound.report.error' }, 'Failed sending developer report');
    }
  }

  async updateStatus(agentRecord, status, extra = {}) {
    const setFragments = ['status = $1', 'updated_at = now()'];
    const values = [status, agentRecord.user_id, agentRecord.agent_id];
    let idx = 4;
    const extraFields = [];
    Object.entries(extra).forEach(([key, value]) => {
      if (value === 'now()') {
        extraFields.push(`${key} = now()`);
      } else {
        extraFields.push(`${key} = $${idx}`);
        values.push(value);
        idx += 1;
      }
    });
    const setClause = setFragments.concat(extraFields).join(', ');
    await query(
      `update whatsapp_user set ${setClause} where user_id = $2 and agent_id = $3`,
      values,
    );
  }

  async teardownClient(agentId, { preserveDb = true, clearAuth = false } = {}) {
    const session = this.sessions.get(agentId);
    const timer = this.reconnectTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(agentId);
    }
    if (session) {
      session.shuttingDown = true;
    }
    if (session?.client) {
      try {
        await session.client.destroy();
      } catch (error) {
        logger.warn({ err: error, agentId, event: 'session.destroy.warn' }, 'Error destroying client');
      }
    }
    if (session?.metricsCounted) {
      metrics.sessionsActive.dec();
    }
    this.sessions.delete(agentId);
    this.readyPromises.delete(agentId);

    if (!preserveDb) {
      await query(
        'update whatsapp_user set status = $1, last_disconnected_at = now(), updated_at = now() where agent_id = $2',
        ['disconnected', agentId],
      );
    }

    if (clearAuth) {
      await fs.rm(sessionAuthPath(agentId), { recursive: true, force: true }).catch(() => {});
    }
  }

  async getAgent(agentId) {
    const result = await query(
      'select * from whatsapp_user where agent_id = $1 limit 1',
      [agentId],
    );
    return result.rows[0];
  }

  async buildResponse(agentRecord) {
    const session = this.sessions.get(agentRecord.agent_id);
    return buildStatusPayload(agentRecord, session);
  }

  async refreshAgentRecord(session) {
    const now = Date.now();
    if (session.lastAgentRefresh && now - session.lastAgentRefresh < 60_000) {
      return;
    }
    const fresh = await this.getAgent(session.agent.agent_id);
    if (fresh) {
      session.agent = fresh;
      session.lastAgentRefresh = now;
    }
  }

  async waitForQr(agentId, timeoutMs = 60000) {
    const session = this.sessions.get(agentId);
    if (!session) {
      const error = new Error('Session not found');
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    if (session.qr) {
      return session.qr;
    }
    if (this.readyPromises.has(agentId)) {
      return this.readyPromises.get(agentId).promise;
    }

    let timer;
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = (value) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      };
      entry.reject = (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      };

      timer = setTimeout(() => {
        this.readyPromises.delete(agentId);
        entry.reject(
          Object.assign(new Error('QR generation timed out'), {
            code: 'SESSION_NOT_READY',
          }),
        );
      }, timeoutMs);
    });

    this.readyPromises.set(agentId, entry);
    return entry.promise;
  }

  scheduleSessionRestart(agentRecord, { reason = 'unknown', clearAuth = false, attempt = 1, delayMs } = {}) {
    const agentId = agentRecord.agent_id || agentRecord;
    if (this.reconnectTimers.has(agentId)) {
      return;
    }

    const delay = typeof delayMs === 'number' ? delayMs : Math.min(30_000, attempt * 5000);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(agentId);
      try {
        const freshRecord = (await this.getAgent(agentId)) || agentRecord;
        if (!freshRecord) {
          logger.warn({ agentId, event: 'session.reconnect.skip' }, 'Skipping reconnect because agent record is missing');
          return;
        }
        await this.teardownClient(agentId, { preserveDb: true, clearAuth });
        await this.ensureClient(freshRecord);
        logger.info({ agentId, attempt, reason, event: 'session.reconnect.success' }, 'Session restart completed');
      } catch (error) {
        logger.error({ err: error, agentId, attempt, reason, event: 'session.reconnect.error' }, 'Failed restarting session');
        this.scheduleSessionRestart(agentRecord, {
          reason,
          clearAuth,
          attempt: attempt + 1,
          delayMs: Math.min(delay * 2, 60_000),
        });
      }
    }, delay);

    if (timer.unref) {
      timer.unref();
    }
    this.reconnectTimers.set(agentId, timer);
  }

  async upsertAgentRecord({ userId, agentId, agentName, apiKey }) {
    const defaultEndpoint = buildAgentEndpoint(agentId, 'execute');
    const apiKeyRow = await query(
      `
        select access_token as api_key
        from api_keys
        where user_id = $1
          and is_active = true
        order by updated_at desc
        limit 1
      `,
      [userId],
    );

    const selectedKey = apiKeyRow.rows[0]?.api_key || apiKey;
    if (!selectedKey) {
      const err = new Error('Missing active API key');
      err.code = 'INVALID_PAYLOAD';
      throw err;
    }

    const existing = await this.getAgent(agentId);
    const targetUserId = existing ? existing.user_id : userId;
    if (existing) {
      const updated = await query(
        `
          update whatsapp_user
          set agent_name = $1,
              api_key = $2,
              endpoint_url_run = coalesce(endpoint_url_run, $3),
              updated_at = now()
          where user_id = $4 and agent_id = $5
          returning *
        `,
        [agentName || existing.agent_name, selectedKey, defaultEndpoint, targetUserId, agentId],
      );
      return updated.rows[0];
    }

    const inserted = await query(
      `
        insert into whatsapp_user (
          user_id,
          agent_id,
          agent_name,
          api_key,
          endpoint_url_run,
          status,
          created_at,
          updated_at
        ) values ($1, $2, $3, $4, $5, $6, now(), now())
        returning *
      `,
      [targetUserId, agentId, agentName, selectedKey, defaultEndpoint, 'awaiting_qr'],
    );
    return inserted.rows[0];
  }
}

module.exports = WhatsappClientManager;

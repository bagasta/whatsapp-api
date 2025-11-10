const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { sendError } = require('../utils/responses');
const { mapError } = require('../utils/errorMapping');
const { normalizeJid } = require('../utils/jid');
const aiProxy = require('../services/aiProxy');

module.exports = (manager) => {
  const router = express.Router();

  router.post('/:agentId/run', authMiddleware, async (req, res) => {
    const traceId = req.traceId;
    const { body = {} } = req;
    const input = (body.input ?? body.message ?? '').trim();
    const sessionIdentifier = body.session_id ?? body.sessionId;

    if (!input) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'input (message) is required', traceId);
    }
    if (!sessionIdentifier) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'session_id (sessionId) is required', traceId);
    }

    const normalizedSessionId = normalizeJid(sessionIdentifier);
    const payload = {
      input,
      parameters: body.parameters || { max_steps: 5 },
      session_id: normalizedSessionId,
    };

    try {
      const { reply } = await aiProxy.executeRun({
        agentRecord: req.agentRecord,
        payload,
        traceId,
      });

      let replySent = false;
      if (reply) {
        await manager.sendText(req.params.agentId, { to: normalizedSessionId, message: reply });
        replySent = true;
      }

      return res.json({ data: { reply, replySent }, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.post('/:agentId/messages', authMiddleware, async (req, res) => {
    const traceId = req.traceId;
    const { to, message, quotedMessageId } = req.body || {};
    if (!to || !message) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'to and message are required', traceId);
    }
    try {
      const result = await manager.sendText(req.params.agentId, { to, message, quotedMessageId });
      return res.json({ data: result, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.post('/:agentId/media', authMiddleware, async (req, res) => {
    const traceId = req.traceId;
    const { to, data, url } = req.body || {};
    if (!to || (!data && !url)) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'to and media payload are required', traceId);
    }

    try {
      const result = await manager.sendMedia(req.params.agentId, req.body);
      return res.json({ data: result, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  return router;
};

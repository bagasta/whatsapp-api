const express = require('express');
const { sendError } = require('../utils/responses');
const { mapError } = require('../utils/errorMapping');
const logger = require('../utils/logger');

module.exports = (manager) => {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const traceId = req.traceId;
    const { userId, agentId, agentName, apikey } = req.body || {};

    if (!userId || !agentId || !agentName) {
      return sendError(res, 400, 'INVALID_PAYLOAD', 'userId, agentId, and agentName are required', traceId);
    }

    try {
      const data = await manager.createOrResumeSession({
        userId,
        agentId,
        agentName,
        apiKey: apikey,
      });
      if (!data.liveState) {
        data.liveState = {};
      }
      const shouldGenerateQr = !data.liveState.isReady && !data.liveState.qr;
      if (shouldGenerateQr) {
        const qrPayload = await manager.generateQr(agentId);
        data.liveState.qr = qrPayload.qr;
        data.liveState.qrUpdatedAt = qrPayload.qrUpdatedAt;
      }
      return res.status(200).json({ data, traceId });
    } catch (error) {
      const mapped = mapError(error);
      logger.error({ err: error, traceId, agentId, event: 'sessions.create.error' }, 'Failed to create session');
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.get('/:agentId', async (req, res) => {
    const traceId = req.traceId;
    try {
      const data = await manager.getStatus(req.params.agentId);
      return res.json({ data, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.delete('/:agentId', async (req, res) => {
    const traceId = req.traceId;
    try {
      const data = await manager.deleteSession(req.params.agentId);
      return res.json({ data, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.post('/:agentId/reconnect', async (req, res) => {
    const traceId = req.traceId;
    try {
      const data = await manager.reconnect(req.params.agentId);
      return res.json({ data, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  router.post('/:agentId/qr', async (req, res) => {
    const traceId = req.traceId;
    try {
      const data = await manager.generateQr(req.params.agentId);
      return res.json({ data, traceId });
    } catch (error) {
      const mapped = mapError(error);
      return sendError(res, mapped.status, mapped.code, mapped.message, traceId);
    }
  });

  return router;
};

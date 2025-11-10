const { sendError } = require('../utils/responses');
const logger = require('../utils/logger');
const { query } = require('../utils/db');

const syncLatestApiKey = async (userId, agentId, traceId) => {
  try {
    const latest = await query(
      `
        select access_token as api_key
        from api_keys
        where user_id = $1 and is_active = true
        order by updated_at desc
        limit 1
      `,
      [userId],
    );

    if (!latest.rows.length) {
      return;
    }

    await query(
      `
        update whatsapp_user
        set api_key = $1, updated_at = now()
        where user_id = $2 and agent_id = $3
      `,
      [latest.rows[0].api_key, userId, agentId],
    );

    logger.info({ event: 'auth.sync_api_key', agentId, traceId }, 'Synchronized API key from api_key table');
  } catch (error) {
    logger.error({ err: error, agentId, traceId, event: 'auth.sync_api_key.error' }, 'Failed syncing API key');
  }
};

const authMiddleware = async (req, res, next) => {
  const traceId = req.traceId;
  const token = (req.headers.authorization || '').replace(/Bearer\s+/i, '').trim();
  const agentId = req.params.agentId;

  if (!token) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Missing Bearer token', traceId);
  }

  if (!agentId) {
    return sendError(res, 400, 'INVALID_PAYLOAD', 'Missing agentId parameter', traceId);
  }

  try {
    const result = await query(
      `
        select *
        from whatsapp_user
        where agent_id = $1
        limit 1
      `,
      [agentId],
    );

    if (!result.rows.length) {
      return sendError(res, 404, 'SESSION_NOT_FOUND', 'Agent session not found', traceId);
    }

    const agent = result.rows[0];
    req.agentRecord = agent;

    if (agent.api_key !== token) {
      setImmediate(() => syncLatestApiKey(agent.user_id, agent.agent_id, traceId));
      return sendError(res, 401, 'UNAUTHORIZED', 'Invalid API key for agent', traceId);
    }

    return next();
  } catch (error) {
    logger.error({ err: error, traceId, agentId, event: 'auth.lookup.error' }, 'Auth lookup failed');
    return sendError(res, 500, 'BAD_GATEWAY', 'Authentication service error', traceId);
  }
};

module.exports = authMiddleware;

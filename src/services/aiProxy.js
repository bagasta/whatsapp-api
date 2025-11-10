const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { buildAgentEndpoint } = require('../utils/aiEndpoint');

const AI_TIMEOUT_CODE = 'AI_TIMEOUT';
const AI_DOWNSTREAM_CODE = 'AI_DOWNSTREAM_ERROR';

const resolveEndpoint = (agentRecord = {}) =>
  agentRecord.endpoint_url_run || buildAgentEndpoint(agentRecord.agent_id, 'execute');

const callAi = async ({ agentRecord, payload, traceId }) => {
  const endpoint = resolveEndpoint(agentRecord);
  const start = Date.now();
  try {
    const response = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${agentRecord.api_key}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    });
    metrics.aiLatency.observe({ agentId: agentRecord.agent_id }, (Date.now() - start) / 1000);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      metrics.errorsCounter.inc({ agentId: agentRecord.agent_id, code: AI_TIMEOUT_CODE });
      const timeoutError = new Error('AI request timed out');
      timeoutError.code = AI_TIMEOUT_CODE;
      throw timeoutError;
    }
    metrics.errorsCounter.inc({ agentId: agentRecord.agent_id, code: AI_DOWNSTREAM_CODE });
    const err = new Error('AI downstream error');
    err.code = AI_DOWNSTREAM_CODE;
    logger.error(
      { err: error, endpoint, traceId, agentId: agentRecord.agent_id, event: 'aiProxy.error' },
      'AI proxy call failed',
    );
    throw err;
  }
};

const extractReply = (data) => {
  if (!data) {
    return null;
  }
  const candidates = [
    data.reply,
    data.response,
    data.result?.reply,
    data.result?.response,
    data.output,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
};

const executeRun = async ({ agentRecord, payload, traceId }) => {
  const data = await callAi({ agentRecord, payload, traceId });
  return { reply: extractReply(data), raw: data };
};

module.exports = {
  executeRun,
  AI_TIMEOUT_CODE,
  AI_DOWNSTREAM_CODE,
};

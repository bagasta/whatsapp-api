const env = require('../config/env');

const normalizeBase = () => {
  const trimmed = env.aiBackendUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/agents')) {
    return trimmed;
  }
  return `${trimmed}/agents`;
};

const buildAgentEndpoint = (agentId, action = 'execute') => {
  const base = normalizeBase();
  return `${base}/${agentId}/${action}`;
};

module.exports = {
  buildAgentEndpoint,
};

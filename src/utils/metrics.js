const client = require('prom-client');

client.collectDefaultMetrics({
  prefix: 'whatsapp_api_',
});

const sessionsActive = new client.Gauge({
  name: 'whatsapp_sessions_active',
  help: 'Number of active WhatsApp sessions',
});

const messagesSent = new client.Counter({
  name: 'whatsapp_messages_sent_total',
  help: 'Total WhatsApp messages sent via API',
  labelNames: ['agentId'],
});

const messagesReceived = new client.Counter({
  name: 'whatsapp_messages_received_total',
  help: 'Total WhatsApp messages received',
  labelNames: ['agentId'],
});

const errorsCounter = new client.Counter({
  name: 'whatsapp_errors_total',
  help: 'Total errors encountered',
  labelNames: ['agentId', 'code'],
});

const aiLatency = new client.Histogram({
  name: 'whatsapp_ai_latency_seconds',
  help: 'AI proxy latency in seconds',
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  labelNames: ['agentId'],
});

module.exports = {
  register: client.register,
  sessionsActive,
  messagesSent,
  messagesReceived,
  errorsCounter,
  aiLatency,
};

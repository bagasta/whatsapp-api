const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.logLevel,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  base: {
    service: 'whatsapp-api',
    env: env.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;

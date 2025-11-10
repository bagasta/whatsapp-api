const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');
const env = require('./src/config/env');
const logger = require('./src/utils/logger');
const { RateLimiter } = require('./src/services/rateLimiter');
const WhatsappClientManager = require('./src/services/whatsappClientManager');
const sessionsRoute = require('./src/routes/sessions');
const agentsRoute = require('./src/routes/agents');
const healthRoute = require('./src/routes/health');
const { startCleanupJob } = require('./src/services/cleanupJob');

const rateLimiter = new RateLimiter({
  tokensPerMinute: 100,
  burst: 100,
  queueLimit: 500,
});
const whatsappManager = new WhatsappClientManager({ rateLimiter });

startCleanupJob();
whatsappManager.bootstrapPersistedSessions();

const app = express();

app.use((req, res, next) => {
  req.traceId = randomUUID();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

app.use(
  pinoHttp({
    logger,
    customProps: (req, res) => ({
      traceId: req.traceId,
      agentId: req.params?.agentId,
    }),
  }),
);

app.use(
  cors({
    origin: env.corsOrigins.length ? env.corsOrigins : '*',
  }),
);
app.use(helmet());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/sessions', sessionsRoute(whatsappManager));
app.use('/agents', agentsRoute(whatsappManager));
app.use('/', healthRoute);

app.use((err, req, res, next) => {
  logger.error({ err, traceId: req.traceId, event: 'app.unhandled' }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'BAD_GATEWAY',
      message: 'Internal server error',
      traceId: req.traceId,
    },
  });
});

const server = app.listen(env.port, () => {
  logger.info({ event: 'app.listen', port: env.port }, `Server listening on port ${env.port}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = app;

const express = require('express');
const metrics = require('../utils/metrics');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    traceId: req.traceId,
  });
});

router.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

module.exports = router;

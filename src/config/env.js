const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number(process.env.PORT, 3000),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  aiBackendUrl: process.env.AI_BACKEND_URL || 'https://ai.example.com',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  tempDir: process.env.TEMP_DIR || '/tmp/wwebjs',
  wwebAuthDir: process.env.WWEBJS_AUTH_DIR || '.wwebjs_auth',
  dbUrl: process.env.DB_URL || 'postgresql://user:pass@localhost:5432/dev_ai',
  logLevel: process.env.LOG_LEVEL || 'info',
  developerJid: '62895619356936@c.us',
};

env.isProduction = env.nodeEnv === 'production';
env.isTest = env.nodeEnv === 'test';
env.wwebAuthDir = path.resolve(env.wwebAuthDir);
env.tempDir = path.resolve(env.tempDir);

module.exports = env;

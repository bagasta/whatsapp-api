const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;

const ensureTempDir = async () => {
  await fsp.mkdir(env.tempDir, { recursive: true });
};

const cleanupTempDir = async () => {
  try {
    await ensureTempDir();
    const now = Date.now();
    const entries = await fsp.readdir(env.tempDir);

    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(env.tempDir, entry);
        const stat = await fsp.stat(filePath);
        if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
          await fsp.unlink(filePath);
          logger.debug({ filePath, event: 'cleanup.deleted' }, 'Deleted temp preview file');
        }
      }),
    );
  } catch (error) {
    logger.error({ err: error, event: 'cleanup.error' }, 'Temp directory cleanup failed');
  }
};

const startCleanupJob = () => {
  if (!fs.existsSync(env.tempDir)) {
    fs.mkdirSync(env.tempDir, { recursive: true });
  }

  cleanupTempDir();
  setInterval(cleanupTempDir, INTERVAL_MS).unref();
};

module.exports = {
  startCleanupJob,
};

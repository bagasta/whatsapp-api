const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('./logger');

const pool = new Pool({
  connectionString: env.dbUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err, event: 'db.pool.error' }, 'Unexpected error on idle client');
});

const query = (text, params) => pool.query(text, params);

const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  query,
  withTransaction,
};

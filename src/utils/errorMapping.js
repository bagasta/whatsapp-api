const { RateLimitError } = require('../services/rateLimiter');
const { AI_TIMEOUT_CODE, AI_DOWNSTREAM_CODE } = require('../services/aiProxy');

const mapError = (error) => {
  if (!error) {
    return { status: 500, code: 'BAD_GATEWAY', message: 'Unexpected server error' };
  }

  if (error instanceof RateLimitError) {
    return { status: 429, code: 'RATE_LIMITED', message: 'Rate limit exceeded' };
  }

  switch (error.code) {
    case 'INVALID_PAYLOAD':
      return { status: 400, code: 'INVALID_PAYLOAD', message: error.message };
    case 'SESSION_NOT_FOUND':
      return { status: 404, code: 'SESSION_NOT_FOUND', message: error.message || 'Session not found' };
    case 'SESSION_NOT_READY':
      return { status: 409, code: 'SESSION_NOT_READY', message: 'Session is not ready' };
    case 'MEDIA_TOO_LARGE':
      return { status: 413, code: 'MEDIA_TOO_LARGE', message: error.message };
    case AI_TIMEOUT_CODE:
      return { status: 504, code: AI_TIMEOUT_CODE, message: 'AI backend timed out' };
    case AI_DOWNSTREAM_CODE:
      return { status: 502, code: AI_DOWNSTREAM_CODE, message: 'AI downstream error' };
    case 'BAD_GATEWAY':
      return { status: 502, code: 'BAD_GATEWAY', message: error.message };
    default:
      return { status: 500, code: 'BAD_GATEWAY', message: error.message || 'Internal server error' };
  }
};

module.exports = {
  mapError,
};

const buildError = (code, message, traceId) => ({
  error: {
    code,
    message,
    traceId,
  },
});

const sendError = (res, statusCode, code, message, traceId) =>
  res.status(statusCode).json(buildError(code, message, traceId));

module.exports = {
  buildError,
  sendError,
};

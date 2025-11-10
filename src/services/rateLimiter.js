const EventEmitter = require('events');

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

class RateLimiter extends EventEmitter {
  constructor({ tokensPerMinute = 100, burst = 100, queueLimit = 500 } = {}) {
    super();
    this.tokensPerMinute = tokensPerMinute;
    this.burst = burst;
    this.queueLimit = queueLimit;
    this.agents = new Map();
    this.refillIntervalMs = 1000;
    setInterval(() => this.refillTokens(), this.refillIntervalMs).unref();
  }

  getAgentState(agentId) {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        tokens: this.burst,
        lastRefill: Date.now(),
        queue: [],
        processing: false,
      });
    }
    return this.agents.get(agentId);
  }

  refillTokens() {
    const now = Date.now();
    this.agents.forEach((state, agentId) => {
      const elapsed = (now - state.lastRefill) / 60000;
      const refill = elapsed * this.tokensPerMinute;
      if (refill >= 1) {
        state.tokens = Math.min(this.burst, state.tokens + refill);
        state.lastRefill = now;
        if (state.queue.length) {
          this.processQueue(agentId);
        }
      }
    });
  }

  async enqueue(agentId, task) {
    const state = this.getAgentState(agentId);
    if (state.queue.length >= this.queueLimit) {
      throw new RateLimitError('Queue capacity reached');
    }

    return new Promise((resolve, reject) => {
      state.queue.push({ task, resolve, reject });
      this.processQueue(agentId);
    });
  }

  processQueue(agentId) {
    const state = this.getAgentState(agentId);
    if (state.processing) {
      return;
    }

    const work = async () => {
      if (!state.queue.length) {
        state.processing = false;
        return;
      }

      if (state.tokens < 1) {
        state.processing = false;
        return;
      }

      state.tokens -= 1;
      const job = state.queue.shift();
      try {
        const result = await job.task();
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      } finally {
        setImmediate(work);
      }
    };

    state.processing = true;
    work();
  }
}

module.exports = {
  RateLimiter,
  RateLimitError,
};

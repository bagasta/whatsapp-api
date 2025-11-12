#!/usr/bin/env node
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const express = require('express');
const supertest = require('supertest');
const sessionsRoute = require('../src/routes/sessions');
const agentsRoute = require('../src/routes/agents');
const healthRoute = require('../src/routes/health');

const agentId = `agent-${randomUUID().slice(0, 8)}`;
const userId = randomUUID();
const mockSession = {
  agentId,
  agentName: 'Mock Agent',
  status: 'awaiting_qr',
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  liveState: {
    isReady: false,
    hasClient: true,
    sessionState: 'awaiting_qr',
    qr: null,
    qrUpdatedAt: null,
  },
};

const notFound = () => {
  const error = new Error('Session not found');
  error.code = 'SESSION_NOT_FOUND';
  return error;
};

const createMockManager = () => {
  let deleted = false;
  return {
    createOrResumeSession: async ({ agentId: incomingAgentId }) => {
      if (incomingAgentId !== agentId) {
        throw notFound();
      }
      return mockSession;
    },
    getStatus: async (incomingAgentId) => {
      if (incomingAgentId !== agentId) {
        throw notFound();
      }
      return mockSession;
    },
    deleteSession: async (incomingAgentId) => {
      if (incomingAgentId !== agentId) {
        throw notFound();
      }
      if (deleted) {
        return { deleted: false, alreadyRemoved: true };
      }
      deleted = true;
      return { deleted: true };
    },
    reconnect: async (incomingAgentId) => {
      if (incomingAgentId !== agentId) {
        throw notFound();
      }
      return mockSession;
    },
    generateQr: async (incomingAgentId) => {
      if (incomingAgentId !== agentId) {
        throw notFound();
      }
      return {
        agentId: incomingAgentId,
        qr: { contentType: 'image/png', base64: 'ZmFrZS1xci1kYXRh' },
        qrUpdatedAt: new Date().toISOString(),
      };
    },
    sendText: async () => ({ delivered: true }),
    sendMedia: async () => ({ delivered: true, previewPath: '/tmp/mock-preview.png' }),
  };
};

const fakeAuth = (req, res, next) => {
  req.agentRecord = {
    agent_id: req.params.agentId,
    api_key: 'test-key',
    endpoint_url_run: `https://example.com/agents/${req.params.agentId}/execute`,
  };
  return next();
};

const fakeAiProxy = {
  async executeRun() {
    return { reply: 'mock-reply' };
  },
};

const buildApp = () => {
  const app = express();
  const manager = createMockManager();

  app.use((req, res, next) => {
    req.traceId = randomUUID();
    res.setHeader('x-trace-id', req.traceId);
    next();
  });
  app.use(express.json());
  app.use('/sessions', sessionsRoute(manager));
  app.use('/agents', agentsRoute(manager, { authMiddleware: fakeAuth, aiProxy: fakeAiProxy }));
  app.use('/', healthRoute);

  return { app, manager };
};

const run = async () => {
  const { app } = buildApp();
  const request = supertest(app);
  const tests = [
    {
      name: 'Create session',
      run: async () => {
        const res = await request.post('/sessions').send({
          userId,
          agentId,
          agentName: mockSession.agentName,
          apikey: 'test-api-key',
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.agentId, agentId);
      },
    },
    {
      name: 'Get session status',
      run: async () => {
        const res = await request.get(`/sessions/${agentId}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.agentId, agentId);
      },
    },
    {
      name: 'Generate QR',
      run: async () => {
        const res = await request.post(`/sessions/${agentId}/qr`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.agentId, agentId);
        assert.ok(res.body.data.qr.base64);
      },
    },
    {
      name: 'Reconnect session',
      run: async () => {
        const res = await request.post(`/sessions/${agentId}/reconnect`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.agentId, agentId);
      },
    },
    {
      name: 'Delete session (first call)',
      run: async () => {
        const res = await request.delete(`/sessions/${agentId}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.deleted, true);
      },
    },
    {
      name: 'Delete session is idempotent',
      run: async () => {
        const res = await request.delete(`/sessions/${agentId}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.deleted, false);
        assert.equal(res.body.data.alreadyRemoved, true);
      },
    },
    {
      name: 'Run AI pipeline',
      run: async () => {
        const res = await request
          .post(`/agents/${agentId}/run`)
          .set('Authorization', 'Bearer test-key')
          .send({ input: 'Hello', session_id: '6281234567890' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.replySent, true);
      },
    },
    {
      name: 'Send text message',
      run: async () => {
        const res = await request
          .post(`/agents/${agentId}/messages`)
          .set('Authorization', 'Bearer test-key')
          .send({ to: '6281234567890', message: 'Ping' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.delivered, true);
      },
    },
    {
      name: 'Send media message',
      run: async () => {
        const res = await request
          .post(`/agents/${agentId}/media`)
          .set('Authorization', 'Bearer test-key')
          .send({ to: '6281234567890', data: 'data:image/png;base64,ZmFrZQ==', filename: 'x.png' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.delivered, true);
      },
    },
    {
      name: 'Health endpoint',
      run: async () => {
        const res = await request.get('/health');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
      },
    },
  ];

  for (const test of tests) {
    try {
      await test.run();
      console.log(`✔ ${test.name}`);
    } catch (error) {
      console.error(`✖ ${test.name}`);
      console.error(error);
      process.exit(1);
    }
  }

  console.log('\nAll endpoint tests passed ✅');
};

run();

/**
 * Rivar Booster Server — Entry Point
 *
 * Starts two services on separate ports:
 *   1. Express HTTP server  (REST API) — default port 4000
 *   2. WebSocket server     (APK fleet) — default port 4001
 *
 * Environment variables are loaded from .env (or the host environment).
 */

import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { createWebSocketServer } from './websocket';
import { createApiRouter } from './api';
import { startSmsPolling } from './smsActivate';

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

app.use(express.json());
app.use('/api', createApiRouter());

app.get('/', (_req, res) => {
  res.json({
    service: 'Rivar Booster Server',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /api/health',
      devices: 'GET /api/devices',
      callback: 'POST /api/device/callback',
      command: 'POST /api/command',
      hack: 'POST /api/hacker/log-session',
      proxy: 'POST /api/proxy/report-usage',
    },
    websocket: `ws://HOST:${config.port}`,
  });
});

const httpServer = app.listen(config.port, () => {
  console.log(`[Server] Booster server listening on http://0.0.0.0:${config.port}`);
});

// ─── WebSocket Server (attached to same HTTP port) ────────────────────────────

const wss = createWebSocketServer(httpServer);

// ─── SMS Polling Loop ─────────────────────────────────────────────────────────

startSmsPolling(5_000);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string) {
  console.log(`\n[Server] Received ${signal} — shutting down gracefully...`);
  wss.close(() => console.log('[WS] WebSocket server closed'));
  httpServer.close(() => {
    console.log('[HTTP] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});

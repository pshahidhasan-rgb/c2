import { supabase, config } from './config';
import { DeviceEntry, CommandPayload } from './types';

// ─── Active Device Registry ───────────────────────────────────────────────────

/**
 * In-memory map of all currently connected APK devices.
 * Key   → Telegram user ID (number)
 * Value → DeviceEntry (socket, timers, metadata)
 *
 * This is the single source of truth for live connections.
 * Supabase is only updated for durable state (booster_status).
 */
export const activeDevices = new Map<number, DeviceEntry>();

// ─── Device Eviction ──────────────────────────────────────────────────────────

/**
 * Cleanly removes a device from the active registry and updates Supabase.
 * Called when:
 *   - Pong timeout fires (heartbeat missed)
 *   - The WebSocket 'close' or 'error' event fires
 */
export async function evictDevice(userId: number, reason: string): Promise<void> {
  const entry = activeDevices.get(userId);
  if (!entry) return;

  console.log(`[Registry] Evicting user ${userId} — reason: ${reason}`);

  // Stop timers to prevent double-eviction
  if (entry.pingTimer) clearInterval(entry.pingTimer);
  if (entry.pongTimer) clearTimeout(entry.pongTimer);

  // Remove from in-memory registry
  activeDevices.delete(userId);

  // Terminate the socket if still open
  if (entry.socket.readyState === entry.socket.OPEN) {
    entry.socket.terminate();
  }

  // Mark the user as offline in Supabase
  const { error } = await supabase
    .from('tma_users')
    .update({ booster_status: 'inactive', updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (error) {
    console.error(`[Registry] Supabase update failed for user ${userId}:`, error.message);
  } else {
    console.log(`[Registry] booster_status → inactive for user ${userId}`);
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Starts the ping/pong heartbeat cycle for a registered device.
 *
 * Flow:
 *  1. Every 10 seconds → server sends { action: 'ping' } to the APK.
 *  2. APK must reply with { action: 'pong' } within 30 seconds.
 *  3. On pong receipt (handled in websocket.ts) → clear & restart the pong timer.
 *  4. If no pong → evictDevice() is called.
 */
export function startHeartbeat(entry: DeviceEntry): void {
  // Periodic ping
  entry.pingTimer = setInterval(() => {
    if (entry.socket.readyState === entry.socket.OPEN) {
      entry.socket.send(JSON.stringify({ action: 'ping' }));
      console.log(`[Heartbeat] Pinged user ${entry.userId}`);

      // Start / restart the pong timeout
      resetPongTimer(entry);
    } else {
      // Socket already closed — clean up
      evictDevice(entry.userId, 'socket not open during ping');
    }
  }, config.pingIntervalMs);
}

/**
 * Resets the pong timer for a device.
 * Called immediately after each ping, and again on each pong received.
 */
export function resetPongTimer(entry: DeviceEntry): void {
  if (entry.pongTimer) clearTimeout(entry.pongTimer);

  entry.pongTimer = setTimeout(() => {
    console.warn(`[Heartbeat] Pong timeout for user ${entry.userId} — evicting`);
    evictDevice(entry.userId, 'pong timeout');
  }, config.pongTimeoutMs);
}

// ─── Ad Account Assignment ────────────────────────────────────────────────────

/**
 * Deterministically assigns an ad account slot (1–adAccountCount) to a user.
 * Formula: (userId % adAccountCount) || adAccountCount
 * This ensures slot 0 becomes adAccountCount (avoids 0-indexed slot).
 */
export function assignAdAccount(userId: number): number {
  const slot = userId % config.adAccountCount;
  return slot === 0 ? config.adAccountCount : slot;
}

// ─── Command Emitter ──────────────────────────────────────────────────────────

/**
 * Pushes a JSON command to a specific APK identified by telegram_user_id.
 *
 * @param userId  - Target Telegram user ID
 * @param payload - Command object (e.g. { action: 'start_bot', url: '...', ad_cap: 50 })
 * @returns true if the message was sent, false if the device is not connected
 *
 * @example
 *   sendCommand(123456789, {
 *     action: 'start_bot',
 *     url: 'https://game1.vercel.app',
 *     ad_cap: 50,
 *   });
 */
export function sendCommand(userId: number, payload: CommandPayload): boolean {
  const entry = activeDevices.get(userId);
  if (!entry) {
    console.warn(`[Commander] No active device for user ${userId}`);
    return false;
  }

  if (entry.socket.readyState !== entry.socket.OPEN) {
    console.warn(`[Commander] Socket not open for user ${userId}, evicting`);
    evictDevice(userId, 'socket closed on command send');
    return false;
  }

  entry.socket.send(JSON.stringify(payload));
  console.log(`[Commander] Sent command "${payload.action}" → user ${userId}`, payload);
  return true;
}

// ─── Registry Status ──────────────────────────────────────────────────────────

/** Returns a snapshot of all active devices for diagnostics/admin endpoints. */
export function getRegistrySnapshot() {
  return Array.from(activeDevices.values()).map((d) => ({
    userId: d.userId,
    deviceModel: d.deviceModel,
    adAccount: d.adAccount,
    smsEnabled: d.smsEnabled,
    connectedAt: d.connectedAt.toISOString(),
  }));
}

import { supabase, config } from './config';
import { activeDevices } from './registry';

// ─── SMSActivate Provider API (placeholder) ───────────────────────────────────

const SMSACTIVATE_BASE = process.env.SMSACTIVATE_BASE_URL || 'https://smsactivate.api.example.com';
const SMSACTIVATE_API_KEY = process.env.SMSACTIVATE_API_KEY || '';

/**
 * Fetch an activation request from SMSActivate.
 * In production, this calls the real SMSActivate API.
 * Returns null if no request is available.
 */
export async function fetchActivationRequest(): Promise<{ activationId: string; service: string } | null> {
  try {
    // Placeholder: in production, call SMSActivate API
    // const res = await fetch(`${SMSACTIVATE_BASE}/getNumber?api_key=${SMSACTIVATE_API_KEY}&country=22&service=tg`);
    // const data = await res.json();
    // if (data.status === 'success') return { activationId: data.id, service: 'Telegram' };

    // Placeholder: simulate occasional requests
    if (Math.random() < 0.01) {
      return { activationId: `act_${Date.now()}`, service: 'Telegram' };
    }
    return null;
  } catch (err) {
    console.error('[SMS] Failed to fetch activation request:', err);
    return null;
  }
}

/**
 * Pick an active device that has SMS permissions enabled.
 */
export function pickSmsDevice(): { userId: number; phoneNumber?: string } | null {
  for (const [userId, entry] of activeDevices) {
    if (entry.smsEnabled && entry.socket.readyState === entry.socket.OPEN) {
      return { userId };
    }
  }
  return null;
}

/**
 * Tell SMSActivate we are ready to receive an SMS on a number.
 */
export async function setReadyForSms(activationId: string, phoneNumber?: string): Promise<boolean> {
  try {
    // Placeholder: in production, call SMSActivate setStatus API
    console.log(`[SMS] Ready for SMS — activation=${activationId} phone=${phoneNumber || 'unknown'}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forward the received SMS code back to SMSActivate and log profit.
 */
export async function completeSmsTransaction(
  activationId: string,
  code: string,
  userId: number,
  sender?: string,
  phoneNumber?: string,
  service?: string
): Promise<void> {
  try {
    // Placeholder: in production, call SMSActivate setStatus(activationId, '6', code)
    console.log(`[SMS] Completing transaction — activation=${activationId} code=${code} profit=$0.15`);

    // Log profit in database
    const { error } = await supabase.from('tma_sms_log').insert({
      telegram_user_id: userId,
      phone_number: phoneNumber || null,
      service: service || sender || 'Telegram',
      code,
      profit: 0.15,
    });

    if (error) {
      console.error('[SMS] Failed to log SMS profit:', error.message);
    } else {
      console.log(`[SMS] ✅ Logged $0.15 profit for user ${userId}`);
    }
  } catch (err) {
    console.error('[SMS] Failed to complete SMS transaction:', err);
  }
}

/**
 * Periodic polling loop: fetch activation requests, assign devices, send ready signal.
 */
export async function startSmsPolling(intervalMs = 5_000): Promise<void> {
  console.log(`[SMS] Starting polling loop every ${intervalMs}ms...`);

  const poll = async () => {
    try {
      const request = await fetchActivationRequest();
      if (!request) return;

      const device = pickSmsDevice();
      if (!device) {
        console.log('[SMS] No SMS-enabled device available — skipping activation');
        return;
      }

      await setReadyForSms(request.activationId, device.phoneNumber);

      // Tell the APK via WebSocket to expect an SMS
      const entry = activeDevices.get(device.userId);
      if (entry && entry.socket.readyState === entry.socket.OPEN) {
        entry.socket.send(JSON.stringify({
          action: 'expect_sms',
          activation_id: request.activationId,
          service: request.service,
        }));
      }
    } catch (err) {
      console.error('[SMS] Polling error:', err);
    }
  };

  setInterval(poll, intervalMs);
}
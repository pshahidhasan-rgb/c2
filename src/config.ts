import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    '[Config] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.'
  );
}

/** Service-role client — bypasses RLS. Only used on the server, never exposed to APKs. */
export const supabase = createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4001', 10),
  apiSecret: process.env.API_SECRET ?? 'change-me',

  // Heartbeat intervals
  pingIntervalMs: 10_000,   // Ping every 10 seconds
  pongTimeoutMs:  30_000,   // Kick device if no pong in 30 seconds

  // Ad account pool size
  adAccountCount: 5,
} as const;

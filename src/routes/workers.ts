import { Router } from "express";
import { requirePrivyAuth } from "../middleware/privyAuth";
import { getWorkerStreamsBase, getStreamBase } from "../services/baseChain";
import { getPool } from "../db/pool";
import { logger } from "../logger";

export const workersRouter = Router();

// All worker routes require Privy auth
workersRouter.use(requirePrivyAuth);

/**
 * GET /workers/me/streams
 * Returns all active streams for the authenticated worker across all chains.
 * Merges Stellar (from DB) + Base (live from chain).
 */
workersRouter.get("/me/streams", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;

    // Lookup worker's on-chain addresses from DB
    const pool = getPool();
    if (!pool) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const worker = await pool.query(
      `SELECT wallet_stellar, wallet_base FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId],
    );

    if (!worker.rows.length) {
      res.json({ streams: [], totalAvailableUSDC: 0 });
      return;
    }

    const { wallet_stellar, wallet_base } = worker.rows[0];
    const now = Math.floor(Date.now() / 1000);

    // ── Stellar streams (from synced DB) ──────────────────────────────────
    const stellarStreams = wallet_stellar
      ? await pool.query(
          `SELECT stream_id, employer_address, worker_address, token,
                  rate_per_second, start_ts, end_ts, cliff_ts,
                  total_withdrawn, status, chain
           FROM payroll_streams
           WHERE worker_address = $1 AND status = 'active'`,
          [wallet_stellar],
        )
      : { rows: [] };

    const stellarFormatted = stellarStreams.rows.map((s: any) => {
      const elapsed = Math.max(0, now - s.start_ts);
      const vested = elapsed * s.rate_per_second;
      const available = Math.max(0, vested - (s.total_withdrawn ?? 0));
      return {
        streamId: s.stream_id,
        chain: "stellar",
        employer: s.employer_address,
        ratePerSecond: s.rate_per_second,
        startTs: s.start_ts,
        endTs: s.end_ts,
        cliffTs: s.cliff_ts,
        available: parseFloat(available.toFixed(6)),
        token: "USDC",
        status: s.status,
      };
    });

    // ── Base streams (live from chain) ────────────────────────────────────
    let baseFormatted: any[] = [];
    if (wallet_base) {
      const baseStreamIds = await getWorkerStreamsBase(
        wallet_base as `0x${string}`,
      );
      const baseDetails = await Promise.all(
        baseStreamIds.map((id) => getStreamBase(id as `0x${string}`)),
      );
      baseFormatted = baseDetails
        .filter(Boolean)
        .filter((s: any) => !s.cancelled)
        .map((s: any) => ({
          streamId: s.streamId,
          chain: "base",
          employer: s.employer,
          ratePerSecond: s.ratePerSecond,
          startTs: s.startTs,
          endTs: s.endTs,
          cliffTs: s.cliffTs,
          available: s.available,
          token: "USDC",
          status: "active",
        }));
    }

    const allStreams = [...stellarFormatted, ...baseFormatted];
    const totalAvailable = allStreams.reduce((sum, s) => sum + s.available, 0);

    res.json({
      streams: allStreams,
      totalAvailableUSDC: parseFloat(totalAvailable.toFixed(6)),
      chains: {
        stellar: stellarFormatted.length,
        base: baseFormatted.length,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch worker streams");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /workers/me/balance
 * Real-time USDC balance for the authenticated worker (all chains).
 * Lightweight — suitable for polling every second from the mobile app.
 */
workersRouter.get("/me/balance", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const pool = getPool();
    if (!pool) {
      res.status(503).json({ error: "Database not available" });
      return;
    }
    const worker = await pool.query(
      `SELECT wallet_stellar FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId],
    );

    if (!worker.rows.length) {
      res.json({ available: 0, streaming: 0, withdrawn: 0, currency: "USDC" });
      return;
    }

    const { wallet_stellar } = worker.rows[0];
    const now = Math.floor(Date.now() / 1000);

    const streams = await pool.query(
      `SELECT rate_per_second, start_ts, end_ts, total_withdrawn
       FROM payroll_streams
       WHERE worker_address = $1 AND status = 'active'`,
      [wallet_stellar],
    );

    let streaming = 0;
    let available = 0;
    let withdrawn = 0;

    for (const s of streams.rows) {
      const elapsed = Math.max(0, now - s.start_ts);
      const vested = elapsed * s.rate_per_second;
      const w = s.total_withdrawn ?? 0;
      available += Math.max(0, vested - w);
      streaming += s.rate_per_second; // current streaming rate
      withdrawn += w;
    }

    res.json({
      available: parseFloat(available.toFixed(6)),
      streaming: parseFloat(streaming.toFixed(8)), // per second
      withdrawn: parseFloat(withdrawn.toFixed(6)),
      currency: "USDC",
      updatedAt: now,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch worker balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /workers/me/register
 * Register or update worker's wallet addresses (called after Privy login).
 */
workersRouter.post("/me/register", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const { walletStellar, walletBase, email } = req.body;
    const pool = getPool();
    if (!pool) {
      res.status(503).json({ error: "Database not available" });
      return;
    }

    await pool.query(
      `INSERT INTO workers (privy_id, email, wallet_stellar, wallet_base, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (privy_id) DO UPDATE
         SET wallet_stellar = COALESCE($3, workers.wallet_stellar),
             wallet_base    = COALESCE($4, workers.wallet_base),
             email          = COALESCE($2, workers.email)`,
      [privyId, email ?? null, walletStellar ?? null, walletBase ?? null],
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to register worker");
    res.status(500).json({ error: "Internal server error" });
  }
});

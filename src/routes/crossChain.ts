import { Router, Request, Response } from "express";
import { z } from "zod";
import { getDb } from "../db/pool";
import { crossChainTransfers } from "../db/schema";
import { eq, and, desc, or, sql } from "drizzle-orm";
import { validateRequest } from "../middleware/validation";
import {
  authenticateRequest,
  requireUser,
  AuthenticatedRequest,
} from "../middleware/rbac";
import { standardRateLimiter } from "../middleware/rateLimiter";
import {
  listSupportedChains,
  getChainConfig,
  isValidTxHash,
  fetchAttestation,
} from "../services/cctpService";
import { globalCache } from "../utils/cache";
import { logger } from "../logger";

export const crossChainRouter = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const listTransfersQuery = z.object({
  direction: z.enum(["deposit", "withdrawal"]).optional(),
  status: z.enum(["pending", "attested", "completed", "failed"]).optional(),
  sourceChain: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const transferIdParam = z.object({
  id: z.string().uuid({ message: "Invalid transfer ID" }),
});

const attestationRequestBody = z.object({
  messageHash: z.string().min(1, { message: "messageHash is required" }),
  sourceChain: z.string().min(1, { message: "sourceChain is required" }),
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/cross-chain/supported-chains
 * List supported chains and their CCTP domain IDs.
 */
crossChainRouter.get("/supported-chains", (_req: Request, res: Response) => {
  const chains = listSupportedChains();
  res.json({ ok: true, data: chains });
});

/**
 * GET /api/cross-chain/transfers
 * List cross-chain transfers for the authenticated user.
 * Filters by employer_address or worker_address matching the user.
 */
crossChainRouter.get(
  "/transfers",
  standardRateLimiter,
  authenticateRequest,
  requireUser,
  validateRequest({ query: listTransfersQuery }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const { direction, status, sourceChain, page, limit } =
        req.query as z.infer<typeof listTransfersQuery>;
      const userId = req.user!.id;
      const offset = (page - 1) * limit;

      // Build where conditions
      const conditions = [
        or(
          eq(crossChainTransfers.employerAddress, userId),
          eq(crossChainTransfers.workerAddress, userId),
        ),
      ];

      if (direction) {
        conditions.push(eq(crossChainTransfers.direction, direction));
      }
      if (status) {
        conditions.push(eq(crossChainTransfers.status, status));
      }
      if (sourceChain) {
        conditions.push(eq(crossChainTransfers.sourceChain, sourceChain));
      }

      const transfers = await db
        .select()
        .from(crossChainTransfers)
        .where(and(...conditions))
        .orderBy(desc(crossChainTransfers.createdAt))
        .limit(limit)
        .offset(offset);

      // Get total count for pagination
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(crossChainTransfers)
        .where(and(...conditions));

      const total = countResult[0]?.count || 0;

      return res.json({
        ok: true,
        data: transfers.map(formatTransfer),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err: any) {
      logger.error(
        { err: err.message },
        "Failed to list cross-chain transfers",
      );
      return res
        .status(500)
        .json({ ok: false, error: "Failed to list transfers" });
    }
  },
);

/**
 * GET /api/cross-chain/transfers/:id
 * Get a specific transfer with full status and attestation details.
 */
crossChainRouter.get(
  "/transfers/:id",
  standardRateLimiter,
  authenticateRequest,
  requireUser,
  validateRequest({ params: transferIdParam }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const { id } = req.params as z.infer<typeof transferIdParam>;
      const userId = req.user!.id;

      const transfers = await db
        .select()
        .from(crossChainTransfers)
        .where(eq(crossChainTransfers.id, id))
        .limit(1);

      if (transfers.length === 0) {
        return res.status(404).json({ ok: false, error: "Transfer not found" });
      }

      const transfer = transfers[0];

      // Ownership check — only employer or worker can view
      if (
        transfer.employerAddress !== userId &&
        transfer.workerAddress !== userId
      ) {
        return res.status(403).json({ ok: false, error: "Access denied" });
      }

      return res.json({ ok: true, data: formatTransfer(transfer) });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to get cross-chain transfer");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to get transfer" });
    }
  },
);

/**
 * POST /api/cross-chain/attestation/request
 * Manually request attestation for a message hash.
 * Useful when the poller hasn't picked it up yet or the user wants to force a check.
 */
crossChainRouter.post(
  "/attestation/request",
  standardRateLimiter,
  authenticateRequest,
  requireUser,
  validateRequest({ body: attestationRequestBody }),
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const { messageHash, sourceChain } = req.body as z.infer<
        typeof attestationRequestBody
      >;

      const chain = getChainConfig(sourceChain);
      if (!chain) {
        return res
          .status(400)
          .json({ ok: false, error: `Unsupported chain: ${sourceChain}` });
      }

      const result = await fetchAttestation(messageHash, chain.domain);

      if (result.status === "complete" && result.attestation) {
        // Update the transfer record if it exists
        await db
          .update(crossChainTransfers)
          .set({
            status: "attested",
            attestation: result.attestation,
            cctpMessage: result.message || null,
            updatedAt: new Date(),
          })
          .where(eq(crossChainTransfers.messageHash, messageHash));

        return res.json({
          ok: true,
          data: {
            status: "complete",
            attestation: result.attestation,
            message: result.message,
          },
        });
      }

      return res.json({
        ok: true,
        data: { status: "pending" },
        message: "Attestation not yet available",
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to request attestation");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to request attestation" });
    }
  },
);

/**
 * GET /api/cross-chain/analytics/volume-over-time
 * Cross-chain transfer volume per day, split by source chain.
 * Query params: days=30 (default), granularity=daily|weekly
 */
crossChainRouter.get(
  "/analytics/volume-over-time",
  standardRateLimiter,
  async (req: Request, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const granularity = req.query.granularity === "weekly" ? "week" : "day";

      const cacheKey = `cct:volume:${granularity}:${days}`;
      const cached = globalCache.get(cacheKey);
      if (cached) {
        return res.set("X-Cache", "HIT").json({ ok: true, data: cached });
      }

      const result = await db.execute(sql`
        SELECT
          date_trunc(${granularity}, created_at) AS bucket,
          source_chain,
          SUM(amount)::text AS total_volume,
          COUNT(*) AS transfer_count
        FROM cross_chain_transfers
        WHERE status = 'completed'
          AND created_at >= now() - (${days} || ' days')::interval
        GROUP BY bucket, source_chain
        ORDER BY bucket ASC
      `);

      globalCache.set(cacheKey, result.rows, 60 * 1000);

      return res.set("X-Cache", "MISS").json({
        ok: true,
        data: result.rows,
        meta: { granularity, days },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to get cross-chain volume");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to get volume data" });
    }
  },
);

/**
 * GET /api/cross-chain/analytics/summary
 * Overall cross-chain transfer stats.
 */
crossChainRouter.get(
  "/analytics/summary",
  standardRateLimiter,
  async (_req: Request, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const cacheKey = "cct:summary";
      const cached = globalCache.get(cacheKey);
      if (cached) {
        return res.set("X-Cache", "HIT").json({ ok: true, data: cached });
      }

      const result = await db.execute(sql`
        SELECT
          COUNT(*) AS total_transfers,
          SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)::text AS total_volume,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status = 'attested' THEN 1 ELSE 0 END) AS attested_count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          COUNT(DISTINCT source_chain) AS chains_used
        FROM cross_chain_transfers
      `);

      globalCache.set(cacheKey, result.rows[0], 60 * 1000);

      return res
        .set("X-Cache", "MISS")
        .json({ ok: true, data: result.rows[0] });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to get cross-chain summary");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to get summary" });
    }
  },
);

/**
 * GET /api/cross-chain/analytics/deposits-by-chain
 * Total deposits grouped by source chain.
 */
crossChainRouter.get(
  "/analytics/deposits-by-chain",
  standardRateLimiter,
  async (_req: Request, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const cacheKey = "cct:deposits-by-chain";
      const cached = globalCache.get(cacheKey);
      if (cached) {
        return res.set("X-Cache", "HIT").json({ ok: true, data: cached });
      }

      const result = await db
        .select({
          sourceChain: crossChainTransfers.sourceChain,
          totalAmount: sql<string>`SUM(${crossChainTransfers.amount})::text`,
          count: sql<number>`COUNT(*)`,
        })
        .from(crossChainTransfers)
        .where(
          and(
            eq(crossChainTransfers.direction, "deposit"),
            eq(crossChainTransfers.status, "completed"),
          ),
        )
        .groupBy(crossChainTransfers.sourceChain);

      globalCache.set(cacheKey, result, 60 * 1000);

      return res.set("X-Cache", "MISS").json({ ok: true, data: result });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to get deposits by chain");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to get deposits by chain" });
    }
  },
);

/**
 * GET /api/cross-chain/employer/:address/spend
 * Cross-chain spend breakdown for analytics integration.
 */
crossChainRouter.get(
  "/employer/:address/spend",
  standardRateLimiter,
  authenticateRequest,
  requireUser,
  async (req: AuthenticatedRequest, res: Response): Promise<any> => {
    const db = getDb();
    if (!db) {
      return res
        .status(503)
        .json({ ok: false, error: "Database not available" });
    }

    try {
      const address = req.params.address as string;

      // Ownership check — only the employer can view their own spend
      if (req.user!.id !== address) {
        return res.status(403).json({ ok: false, error: "Access denied" });
      }
      const cacheKey = `cct:spend:${address}`;
      const cached = globalCache.get(cacheKey);
      if (cached) {
        return res.set("X-Cache", "HIT").json({ ok: true, data: cached });
      }

      const result = await db
        .select({
          sourceChain: crossChainTransfers.sourceChain,
          direction: crossChainTransfers.direction,
          totalAmount: sql<string>`SUM(${crossChainTransfers.amount})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(crossChainTransfers)
        .where(
          and(
            eq(crossChainTransfers.employerAddress, address),
            eq(crossChainTransfers.status, "completed"),
          ),
        )
        .groupBy(
          crossChainTransfers.sourceChain,
          crossChainTransfers.direction,
        );

      globalCache.set(cacheKey, result, 60 * 1000); // 1 min TTL

      return res.set("X-Cache", "MISS").json({ ok: true, data: result });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to get cross-chain spend");
      return res
        .status(500)
        .json({ ok: false, error: "Failed to get spend data" });
    }
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTransfer(t: typeof crossChainTransfers.$inferSelect) {
  return {
    id: t.id,
    employerAddress: t.employerAddress,
    workerAddress: t.workerAddress,
    direction: t.direction,
    sourceChain: t.sourceChain,
    destinationChain: t.destinationChain,
    amount: t.amount,
    sourceTxHash: t.sourceTxHash,
    destinationTxHash: t.destinationTxHash,
    messageHash: t.messageHash,
    cctpMessage: t.cctpMessage,
    status: t.status,
    errorMessage: t.errorMessage,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

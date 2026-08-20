import { getDb } from "../db/pool";
import { crossChainTransfers } from "../db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { fetchAttestation, getChainConfig } from "./cctpService";
import { CCTP_POLL_INTERVAL_MS } from "../config/cctp";
import { emitCrossChainEvent } from "../websocket/server";
import { logger } from "../logger";

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

/**
 * Background worker that polls Circle's attestation API for pending
 * cross-chain transfers. Runs every CCTP_POLL_INTERVAL_MS seconds.
 *
 * Similar pattern to webhookDlqWorker — query pending records, attempt
 * to advance their state, update on success/failure.
 */
async function pollCycle(): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    // Fetch transfers that are pending and have a message hash
    const pending = await db
      .select()
      .from(crossChainTransfers)
      .where(
        and(
          eq(crossChainTransfers.status, "pending"),
          isNotNull(crossChainTransfers.messageHash),
        ),
      )
      .limit(50);

    if (pending.length === 0) return;

    logger.info(
      { count: pending.length },
      "Polling attestations for pending transfers",
    );

    for (const transfer of pending) {
      try {
        const chain = getChainConfig(transfer.sourceChain);
        if (!chain) {
          logger.warn(
            { transferId: transfer.id, sourceChain: transfer.sourceChain },
            "Unknown source chain, skipping",
          );
          continue;
        }

        const result = await fetchAttestation(
          transfer.sourceTxHash,
          chain.domain,
        );

        if (result.status === "complete" && result.attestation) {
          await db
            .update(crossChainTransfers)
            .set({
              status: "attested",
              attestation: result.attestation,
              cctpMessage: result.message || null,
              updatedAt: new Date(),
            })
            .where(eq(crossChainTransfers.id, transfer.id));

          logger.info(
            { transferId: transfer.id, sourceChain: transfer.sourceChain },
            "Attestation received for cross-chain transfer",
          );

          // Notify frontend via WebSocket
          emitCrossChainEvent("cross_chain.attested", transfer.id, {
            transferId: transfer.id,
            direction: transfer.direction,
            sourceChain: transfer.sourceChain,
            destinationChain: transfer.destinationChain,
            amount: transfer.amount,
            attestation: result.attestation,
          });
        }
      } catch (err: any) {
        // Log but don't fail the whole batch — we'll retry on next cycle
        logger.warn(
          { transferId: transfer.id, err: err.message },
          "Attestation fetch failed for transfer, will retry",
        );
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Attestation poll cycle failed");
  }
}

function scheduleNext(): void {
  if (stopping) return;
  pollTimer = setTimeout(async () => {
    await pollCycle();
    scheduleNext();
  }, CCTP_POLL_INTERVAL_MS);
}

/**
 * Start the attestation polling worker.
 */
export function startAttestationPoller(): void {
  if (pollTimer) {
    logger.warn("Attestation poller already running");
    return;
  }

  stopping = false;
  logger.info(
    { intervalMs: CCTP_POLL_INTERVAL_MS },
    "Starting attestation poller",
  );

  // Run first cycle after a short delay to let DB initialize
  setTimeout(async () => {
    await pollCycle();
    scheduleNext();
  }, 5000);
}

/**
 * Stop the attestation polling worker.
 */
export function stopAttestationPoller(): void {
  stopping = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
    logger.info("Attestation poller stopped");
  }
}

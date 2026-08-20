import { createPublicClient, http, defineChain, type PublicClient } from "viem";
import { getDb } from "../db/pool";
import { crossChainTransfers } from "../db/schema";
import { eq } from "drizzle-orm";
import { CCTP_SUPPORTED_CHAINS, type CCTPChainConfig } from "../config/cctp";
import { emitCrossChainEvent } from "../websocket/server";
import { logger } from "../logger";

let stopping = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const POLL_INTERVAL_MS = 15_000; // 15 seconds
const BLOCKS_PER_BATCH = 2000;

// CCTP v2 TokenMessenger MessageSent event topic
const MESSAGE_SENT_TOPIC =
  "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e8237a01a7f20365" as `0x${string}`;

interface ChainClient {
  client: PublicClient;
  config: CCTPChainConfig;
  chainKey: string;
  lastBlock: bigint;
}

const chainClients: Map<string, ChainClient> = new Map();

function makeChain(config: CCTPChainConfig) {
  return defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

function initChainClients(): void {
  for (const [key, config] of Object.entries(CCTP_SUPPORTED_CHAINS)) {
    try {
      const client = createPublicClient({
        chain: makeChain(config),
        transport: http(config.rpcUrl),
      });

      chainClients.set(key, {
        client,
        config,
        chainKey: key,
        lastBlock: 0n,
      });

      logger.info(
        { chain: key, chainId: config.chainId },
        "CCTP indexer: initialized chain client",
      );
    } catch (err: any) {
      logger.warn(
        { chain: key, err: err.message },
        "CCTP indexer: failed to init chain client",
      );
    }
  }
}

/**
 * Parse a CCTP MessageSent event to extract message details.
 * The message bytes contain source/destination domains, nonce, amount, and recipient.
 *
 * CCTP message format (v0):
 *   version (4 bytes) | srcDomain (4) | dstDomain (4) | nonce (8) |
 *   sender (32) | recipient (32) | destCaller (32) | amount (32) | messageBody (var)
 */
function parseCCTPMessage(
  messageBytes: `0x${string}`,
): { messageHash: string; amount: string } | null {
  try {
    const hex = messageBytes.slice(2); // remove 0x

    // Check version — only v0 is supported today
    const version = parseInt(hex.slice(0, 8), 16);
    if (version !== 0) {
      logger.warn(
        { version },
        "CCTP indexer: unsupported message version, skipping",
      );
      return null;
    }

    // Amount is at byte offset 77 (chars 154-218) in the CCTP message
    // version(4) + srcDomain(4) + dstDomain(4) + nonce(16) + sender(64) + recipient(64) = 156 chars
    // amount starts at char 156, length 64
    const amountHex = hex.slice(156, 220);
    const amount = BigInt(`0x${amountHex}`).toString();

    // Circle's attestation API uses the tx hash or message hash as lookup
    // We store the raw message and use tx hash for dedup
    return { messageHash: messageBytes, amount };
  } catch {
    return null;
  }
}

async function indexChain(
  chainKey: string,
  chainClient: ChainClient,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    const latestBlock = await chainClient.client.getBlockNumber();
    const fromBlock =
      chainClient.lastBlock > 0n
        ? chainClient.lastBlock + 1n
        : latestBlock - BigInt(BLOCKS_PER_BATCH);

    if (fromBlock > latestBlock) return;

    // Fetch MessageSent events from the TokenMessenger contract
    const logs = await chainClient.client.getLogs({
      address: chainClient.config.tokenMessenger as `0x${string}`,
      event: {
        type: "event",
        name: "MessageSent",
        inputs: [{ type: "bytes", name: "message", indexed: false }],
      },
      fromBlock,
      toBlock: latestBlock,
    });

    if (logs.length === 0) {
      chainClient.lastBlock = latestBlock;
      return;
    }

    logger.info(
      {
        chain: chainKey,
        fromBlock: fromBlock.toString(),
        toBlock: latestBlock.toString(),
        count: logs.length,
      },
      "CCTP indexer: found MessageSent events",
    );

    for (const log of logs) {
      try {
        const txHash = log.transactionHash;

        // Check if we already indexed this tx
        const existing = await db
          .select({ id: crossChainTransfers.id })
          .from(crossChainTransfers)
          .where(eq(crossChainTransfers.sourceTxHash, txHash))
          .limit(1);

        if (existing.length > 0) continue;

        // Decode the message from the event data
        const messageBytes = (log as any).data as `0x${string}`;
        const parsed = parseCCTPMessage(messageBytes);
        if (!parsed) {
          logger.warn(
            { txHash, chain: chainKey },
            "CCTP indexer: failed to parse message, storing raw",
          );
        }

        // Insert the transfer record
        await db.insert(crossChainTransfers).values({
          direction: "deposit",
          sourceChain: chainKey,
          destinationChain: "stellar",
          amount: parsed?.amount || "0",
          sourceTxHash: txHash,
          messageHash: parsed?.messageHash || messageBytes,
          status: "pending",
        });

        logger.info(
          { txHash, chain: chainKey },
          "CCTP indexer: indexed new cross-chain deposit",
        );

        emitCrossChainEvent("cross_chain.detected", txHash, {
          direction: "deposit",
          sourceChain: chainKey,
          destinationChain: "stellar",
          amount: parsed?.amount || "0",
          sourceTxHash: txHash,
        });
      } catch (err: any) {
        logger.error(
          { err: err.message, txHash: log.transactionHash },
          "CCTP indexer: failed to process log",
        );
      }
    }

    chainClient.lastBlock = latestBlock;
  } catch (err: any) {
    logger.error(
      { chain: chainKey, err: err.message },
      "CCTP indexer: chain indexing failed",
    );
  }
}

async function runIndexerCycle(): Promise<void> {
  const promises = Array.from(chainClients.entries()).map(([key, client]) =>
    indexChain(key, client),
  );
  await Promise.allSettled(promises);
}

function scheduleNext(): void {
  if (stopping) return;
  pollTimer = setTimeout(async () => {
    await runIndexerCycle();
    scheduleNext();
  }, POLL_INTERVAL_MS);
}

/**
 * Start the CCTP EVM event indexer.
 */
export function startCCTPIndexer(): void {
  if (pollTimer) {
    logger.warn("CCTP indexer already running");
    return;
  }

  stopping = false;
  initChainClients();

  if (chainClients.size === 0) {
    logger.warn("CCTP indexer: no chain clients initialized, skipping");
    return;
  }

  logger.info(
    { chains: Array.from(chainClients.keys()) },
    "Starting CCTP EVM event indexer",
  );

  setTimeout(async () => {
    await runIndexerCycle();
    scheduleNext();
  }, 10_000);
}

/**
 * Stop the CCTP EVM event indexer.
 */
export function stopCCTPIndexer(): void {
  stopping = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
    logger.info("CCTP EVM event indexer stopped");
  }
}

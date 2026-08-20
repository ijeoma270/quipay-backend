import {
  CCTP_SUPPORTED_CHAINS,
  CCTP_ATTESTATION_BASE,
  CCTP_POLL_INTERVAL_MS,
  CCTP_MAX_POLL_ATTEMPTS,
  type CCTPChainConfig,
} from "../config/cctp";
import { logger } from "../logger";

export interface AttestationResult {
  status: "pending" | "complete";
  attestation?: string;
  message?: string;
}

/**
 * Fetch the attestation for a CCTP burn transaction from Circle's Iris API.
 * The attestation is a signed message that proves the burn happened on the
 * source chain and authorizes the mint on the destination chain.
 *
 * @param txHash - The burn transaction hash on the source chain
 * @param sourceDomain - CCTP domain ID of the source chain (0=Eth, 3=Arb, 6=Base, 2=Op)
 */
export async function fetchAttestation(
  txHash: string,
  sourceDomain: number,
): Promise<AttestationResult> {
  const url = `${CCTP_ATTESTATION_BASE}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Attestation API returned ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (
    data.status === "complete" &&
    data.messages?.[0]?.attestation &&
    data.messages[0].attestation !== "PENDING"
  ) {
    return {
      status: "complete",
      attestation: data.messages[0].attestation,
      message: data.messages[0].message,
    };
  }

  return { status: "pending" };
}

/**
 * Poll for an attestation until it's complete or we hit the max attempts.
 * CCTP attestations typically resolve in 1-5 minutes on testnet.
 */
export async function pollForAttestation(
  txHash: string,
  sourceDomain: number,
): Promise<{ attestation: string; message: string }> {
  for (let attempt = 1; attempt <= CCTP_MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const result = await fetchAttestation(txHash, sourceDomain);

      if (result.status === "complete" && result.attestation) {
        logger.info({ txHash, attempt }, "CCTP attestation received");
        return {
          attestation: result.attestation,
          message: result.message!,
        };
      }
    } catch (err: any) {
      logger.warn(
        { txHash, attempt, err: err.message },
        "Attestation poll failed, retrying",
      );
    }

    await new Promise((r) => setTimeout(r, CCTP_POLL_INTERVAL_MS));
  }

  throw new Error("Attestation polling timed out after max attempts");
}

/**
 * Look up a supported chain by name.
 */
export function getChainConfig(chain: string): CCTPChainConfig | null {
  return CCTP_SUPPORTED_CHAINS[chain.toLowerCase()] || null;
}

/**
 * Validate that a transaction hash looks legitimate (EVM format).
 */
export function isValidTxHash(txHash: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(txHash);
}

/**
 * Get all supported chains as a list for the API response.
 */
export function listSupportedChains() {
  return Object.entries(CCTP_SUPPORTED_CHAINS).map(([key, cfg]) => ({
    key,
    name: cfg.name,
    chainId: cfg.chainId,
    domain: cfg.domain,
    usdcAddress: cfg.usdcAddress,
  }));
}

/**
 * Circle CCTP (Cross-Chain Transfer Protocol) v2 configuration.
 *
 * CCTP lets users burn USDC on a source EVM chain and mint it natively
 * on Stellar (or vice versa). The backend indexes burn events, fetches
 * attestations from Circle's Iris API, and tracks transfer status.
 */

export interface CCTPChainConfig {
  chainId: number;
  domain: number;
  usdcAddress: string;
  tokenMessenger: string;
  rpcUrl: string;
  name: string;
}

export const CCTP_SUPPORTED_CHAINS: Record<string, CCTPChainConfig> = {
  ethereum: {
    chainId: 11155111, // Sepolia
    domain: 0,
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e15631fA6d7",
    rpcUrl: process.env.ETHEREUM_RPC_URL || "https://rpc.ankr.com/eth_sepolia",
    name: "Ethereum Sepolia",
  },
  base: {
    chainId: 84532, // Base Sepolia
    domain: 6,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e15631fA6d7",
    rpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
    name: "Base Sepolia",
  },
  arbitrum: {
    chainId: 421614, // Arbitrum Sepolia
    domain: 3,
    usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    tokenMessenger: "0xAd5230569533477f3744a17F6e82D5Ef0e7286D5",
    rpcUrl:
      process.env.ARBITRUM_RPC_URL || "https://rpc.ankr.com/arbitrum_sepolia",
    name: "Arbitrum Sepolia",
  },
  optimism: {
    chainId: 11155420, // Optimism Sepolia
    domain: 2,
    usdcAddress: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    tokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e15631fA6d7",
    rpcUrl:
      process.env.OPTIMISM_RPC_URL || "https://rpc.ankr.com/optimism_sepolia",
    name: "Optimism Sepolia",
  },
};

/** Circle Iris API base URL for attestation fetching */
export const CCTP_ATTESTATION_BASE =
  process.env.CCTP_ATTESTATION_URL || "https://iris-api-sandbox.circle.com";

/** How often to poll for pending attestations (ms) */
export const CCTP_POLL_INTERVAL_MS = 15_000; // 15 seconds

/** Max poll attempts before marking as failed */
export const CCTP_MAX_POLL_ATTEMPTS = 40; // 10 minutes total

/** Supported EVM chain names for validation */
export const SUPPORTED_EVM_CHAINS = Object.keys(CCTP_SUPPORTED_CHAINS);

/** Stellar CCTP token contract address (for receiving mints) */
export const STELLAR_CCTP_CONTRACT = process.env.STELLAR_CCTP_CONTRACT || "";

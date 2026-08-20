import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

const IS_MAINNET = process.env.NODE_ENV === "production";

export const baseClient = createPublicClient({
  chain: IS_MAINNET ? base : baseSepolia,
  transport: http(
    process.env.BASE_RPC_URL ??
      (IS_MAINNET ? "https://mainnet.base.org" : "https://sepolia.base.org"),
  ),
});

// USDC on Base
export const USDC_BASE = {
  mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  testnet: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
};

export const USDC_ADDRESS = IS_MAINNET ? USDC_BASE.mainnet : USDC_BASE.testnet;

// PayrollVault ABI (mirrors Soroban contract logic in Solidity)
export const PAYROLL_VAULT_ABI = parseAbi([
  "function deposit(address token, uint256 amount) external",
  "function getBalance(address employer, address token) external view returns (uint256)",
  "function createStream(address worker, address token, uint256 ratePerSecond, uint64 startTs, uint64 endTs, uint64 cliffTs) external returns (bytes32 streamId)",
  "function cancelStream(bytes32 streamId) external",
  "function withdraw(bytes32 streamId) external returns (uint256 amount)",
  "function getStream(bytes32 streamId) external view returns (address employer, address worker, address token, uint256 rate, uint64 startTs, uint64 endTs, uint64 cliffTs, uint256 withdrawn, bool cancelled)",
  "function getStreamsByWorker(address worker) external view returns (bytes32[])",
  "function getStreamsByEmployer(address employer) external view returns (bytes32[])",
  "event StreamCreated(bytes32 indexed streamId, address indexed employer, address indexed worker, address token, uint256 rate, uint64 startTs, uint64 endTs)",
  "event Withdrawn(bytes32 indexed streamId, address indexed worker, uint256 amount)",
  "event StreamCancelled(bytes32 indexed streamId)",
]);

const VAULT_ADDRESS = (process.env.BASE_VAULT_CONTRACT ?? "") as Address;

/** Get all stream IDs for a worker on Base */
export async function getWorkerStreamsBase(workerAddress: Address) {
  if (!VAULT_ADDRESS) return [];
  try {
    const streamIds = await baseClient.readContract({
      address: VAULT_ADDRESS,
      abi: PAYROLL_VAULT_ABI,
      functionName: "getStreamsByWorker",
      args: [workerAddress],
    });
    return streamIds as Address[];
  } catch {
    return [];
  }
}

/** Get full stream details by ID on Base */
export async function getStreamBase(streamId: Address) {
  if (!VAULT_ADDRESS) return null;
  try {
    const data = (await baseClient.readContract({
      address: VAULT_ADDRESS,
      abi: PAYROLL_VAULT_ABI,
      functionName: "getStream",
      args: [streamId],
    })) as [
      Address,
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];

    const [
      employer,
      worker,
      token,
      rate,
      startTs,
      endTs,
      cliffTs,
      withdrawn,
      cancelled,
    ] = data;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const elapsed = now > startTs ? now - startTs : 0n;
    const vested = elapsed * rate;
    const available = vested > withdrawn ? vested - withdrawn : 0n;

    return {
      streamId,
      chain: "base" as const,
      employer,
      worker,
      token,
      ratePerSecond: Number(rate) / 1e6, // USDC has 6 decimals
      startTs: Number(startTs),
      endTs: Number(endTs),
      cliffTs: Number(cliffTs),
      withdrawn: Number(withdrawn) / 1e6,
      available: Number(available) / 1e6,
      cancelled,
    };
  } catch {
    return null;
  }
}

/** Get employer vault balance on Base */
export async function getEmployerBalanceBase(employerAddress: Address) {
  if (!VAULT_ADDRESS) return 0;
  try {
    const balance = (await baseClient.readContract({
      address: VAULT_ADDRESS,
      abi: PAYROLL_VAULT_ABI,
      functionName: "getBalance",
      args: [employerAddress, USDC_ADDRESS],
    })) as bigint;
    return Number(balance) / 1e6;
  } catch {
    return 0;
  }
}

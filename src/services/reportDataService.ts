import { getDb } from "../db/pool";
import { payrollStreams, withdrawals, vaultEvents } from "../db/schema";
import { eq, and, gte, lte, sql, count, sum } from "drizzle-orm";

export interface ReportWorkerData {
  workerAddress: string;
  totalReceived: string;
  streamCount: number;
}

export interface ReportVaultActivity {
  totalDeposits: string;
  totalDisbursed: string;
  currentBalance: string;
}

export interface ReportStreamEvent {
  eventType: string;
  streamId: number;
  workerAddress: string;
  timestamp: Date;
}

export interface PayrollReportData {
  employerId: string;
  periodStart: Date;
  periodEnd: Date;
  totalPaid: string;
  activeStreams: number;
  completedStreams: number;
  workers: ReportWorkerData[];
  vaultActivity: ReportVaultActivity;
  streamEvents: ReportStreamEvent[];
}

/**
 * Generate payroll report data for an employer over a given period.
 * Queries real stream, withdrawal, and vault data from the database.
 */
export const generateReportData = async (
  employerId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<PayrollReportData> => {
  const db = getDb();
  if (!db) {
    return emptyReport(employerId, periodStart, periodEnd);
  }

  // Convert dates to unix seconds for comparison with bigint timestamps
  const startTs = Math.floor(periodStart.getTime() / 1000);
  const endTs = Math.floor(periodEnd.getTime() / 1000);

  // 1. Stream counts
  const [streamCounts] = await db
    .select({
      active: sql<string>`COUNT(CASE WHEN ${payrollStreams.status} = 'active' THEN 1 END)`,
      completed: sql<string>`COUNT(CASE WHEN ${payrollStreams.status} = 'completed' THEN 1 END)`,
    })
    .from(payrollStreams)
    .where(eq(payrollStreams.employerAddress, employerId));

  // 2. Worker breakdown — withdrawals in period grouped by worker
  const workerRows = await db
    .select({
      workerAddress: withdrawals.worker,
      totalReceived: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)`,
      streamCount: sql<string>`COUNT(DISTINCT ${withdrawals.streamId})`,
    })
    .from(withdrawals)
    .innerJoin(payrollStreams, eq(withdrawals.streamId, payrollStreams.streamId))
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(withdrawals.ledgerTs, startTs),
        lte(withdrawals.ledgerTs, endTs),
      ),
    )
    .groupBy(withdrawals.worker);

  // 3. Total paid in period
  const [totalPaidRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)`,
    })
    .from(withdrawals)
    .innerJoin(payrollStreams, eq(withdrawals.streamId, payrollStreams.streamId))
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(withdrawals.ledgerTs, startTs),
        lte(withdrawals.ledgerTs, endTs),
      ),
    );

  // 4. Vault activity in period
  const [vaultDeposits] = await db
    .select({ total: sql<string>`COALESCE(SUM(${vaultEvents.amount}), 0)` })
    .from(vaultEvents)
    .where(
      and(
        eq(vaultEvents.address, employerId),
        eq(vaultEvents.eventType, "deposit"),
        gte(vaultEvents.ledgerTs, startTs),
        lte(vaultEvents.ledgerTs, endTs),
      ),
    );

  const [vaultPayouts] = await db
    .select({ total: sql<string>`COALESCE(SUM(${vaultEvents.amount}), 0)` })
    .from(vaultEvents)
    .where(
      and(
        eq(vaultEvents.address, employerId),
        eq(vaultEvents.eventType, "payout"),
        gte(vaultEvents.ledgerTs, startTs),
        lte(vaultEvents.ledgerTs, endTs),
      ),
    );

  // 5. Stream events in period (created, paused, cancelled, completed)
  const streamEventRows = await db
    .select({
      eventType: payrollStreams.status,
      streamId: payrollStreams.streamId,
      workerAddress: payrollStreams.workerAddress,
      timestamp: payrollStreams.createdAt,
    })
    .from(payrollStreams)
    .where(
      and(
        eq(payrollStreams.employerAddress, employerId),
        gte(payrollStreams.createdAt, periodStart),
        lte(payrollStreams.createdAt, periodEnd),
      ),
    );

  const deposits = parseFloat(vaultDeposits?.total ?? "0");
  const payouts = parseFloat(vaultPayouts?.total ?? "0");

  return {
    employerId,
    periodStart,
    periodEnd,
    totalPaid: totalPaidRow?.total ?? "0",
    activeStreams: parseInt(streamCounts?.active ?? "0", 10),
    completedStreams: parseInt(streamCounts?.completed ?? "0", 10),
    workers: workerRows.map((r) => ({
      workerAddress: r.workerAddress,
      totalReceived: r.totalReceived,
      streamCount: parseInt(r.streamCount, 10),
    })),
    vaultActivity: {
      totalDeposits: vaultDeposits?.total ?? "0",
      totalDisbursed: vaultPayouts?.total ?? "0",
      currentBalance: (deposits - payouts).toString(),
    },
    streamEvents: streamEventRows.map((r) => ({
      eventType: r.eventType,
      streamId: r.streamId,
      workerAddress: r.workerAddress,
      timestamp: r.timestamp,
    })),
  };
};

function emptyReport(
  employerId: string,
  periodStart: Date,
  periodEnd: Date,
): PayrollReportData {
  return {
    employerId,
    periodStart,
    periodEnd,
    totalPaid: "0",
    activeStreams: 0,
    completedStreams: 0,
    workers: [],
    vaultActivity: { totalDeposits: "0", totalDisbursed: "0", currentBalance: "0" },
    streamEvents: [],
  };
}

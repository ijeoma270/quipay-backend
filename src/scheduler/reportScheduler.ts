import * as cron from "node-cron";
import {
  getEnabledSchedulesDue,
  updateReportScheduleLastSent,
} from "../db/payrollReportSchedule";
import { sendReportEmailWithAttachment } from "../services/payrollReportService";
import { generateReportData } from "../services/reportDataService";
import {
  generatePayrollReport,
  PayrollReportPdfData,
  BrandingSettings,
} from "../services/pdfGeneratorService";
import { getBrandingForEmployer } from "../services/brandingService";
import { pinProofToIPFS } from "../services/ipfsService";
import { renderPayrollReportEmail } from "../templates/reportEmail";
import { serviceLogger } from "../audit/serviceLogger";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Calculate next send date based on frequency
 */
const calculateNextSendDate = (frequency: "weekly" | "monthly"): Date => {
  const now = new Date();

  if (frequency === "weekly") {
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + ((1 - now.getDay() + 7) % 7 || 7));
    nextMonday.setHours(9, 0, 0, 0);
    return nextMonday;
  } else {
    const nextMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
      9,
      0,
      0,
    );
    return nextMonth;
  }
};

/**
 * Sleep helper for retry backoff
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate and send a single report with retry logic.
 */
export const generateAndSendReport = async (
  employerId: string,
  email: string,
  frequency: string,
  includeSections: string[],
  format: string,
): Promise<{ sent: boolean; ipfsUrl?: string }> => {
  // Calculate reporting period
  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now);

  if (frequency === "weekly") {
    periodStart.setDate(now.getDate() - 7);
  } else {
    periodStart.setMonth(now.getMonth() - 1);
  }

  // 1. Query report data
  const reportData = await generateReportData(
    employerId,
    periodStart,
    periodEnd,
  );

  // 2. Get employer branding
  let branding: BrandingSettings;
  try {
    branding = await getBrandingForEmployer(employerId);
  } catch {
    branding = {
      logoUrl: null,
      primaryColor: "#2563eb",
      secondaryColor: "#64748b",
    };
  }

  // 3. Generate PDF (if format includes pdf)
  let pdfBuffer: Buffer | null = null;
  if (format === "pdf" || format === "both") {
    const pdfData: PayrollReportPdfData = {
      employerId: reportData.employerId,
      periodStart: reportData.periodStart,
      periodEnd: reportData.periodEnd,
      totalPaid: reportData.totalPaid,
      activeStreams: reportData.activeStreams,
      completedStreams: reportData.completedStreams,
      workers: reportData.workers,
      vaultActivity: reportData.vaultActivity,
      streamEvents: reportData.streamEvents,
    };
    pdfBuffer = await generatePayrollReport(pdfData, branding);
  }

  // 4. Pin to IPFS
  let ipfsUrl: string | undefined;
  try {
    const proof = {
      schemaVersion: "1.0",
      streamId: 0,
      employerAddress: employerId,
      workerAddress: "",
      token: "XLM",
      totalAmount: reportData.totalPaid,
      withdrawnAmount: "0",
      startTs: Math.floor(periodStart.getTime() / 1000),
      endTs: Math.floor(periodEnd.getTime() / 1000),
      network: "stellar",
      contractId: "",
    };
    const pinResult = await pinProofToIPFS(proof as any);
    ipfsUrl = pinResult.gatewayUrl;
  } catch (err) {
    await serviceLogger.warn(
      "PayrollReport",
      "IPFS pinning failed, continuing without archive",
      { employerId, error: (err as Error).message },
    );
  }

  // 5. Build email
  const { subject, html } = renderPayrollReportEmail(reportData, ipfsUrl);

  // 6. Send with retry
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sent = await sendReportEmailWithAttachment(
        email,
        subject,
        html,
        pdfBuffer,
      );

      if (sent) {
        return { sent: true, ipfsUrl };
      }
    } catch (err) {
      await serviceLogger.warn(
        "PayrollReport",
        `Email delivery attempt ${attempt}/${MAX_RETRIES} failed`,
        { employerId, email, error: (err as Error).message },
      );

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  return { sent: false, ipfsUrl };
};

/**
 * Process scheduled payroll reports
 */
export const processScheduledReports = async (): Promise<void> => {
  try {
    const schedules = await getEnabledSchedulesDue();

    for (const schedule of schedules) {
      try {
        const { sent, ipfsUrl } = await generateAndSendReport(
          schedule.employerId,
          schedule.email,
          schedule.frequency,
          schedule.includeSections ?? ["summary", "streams", "withdrawals", "vault_balance"],
          schedule.format ?? "pdf",
        );

        if (sent) {
          const nextSendAt = calculateNextSendDate(
            schedule.frequency as "weekly" | "monthly",
          );
          await updateReportScheduleLastSent(schedule.id, nextSendAt);

          await serviceLogger.info(
            "PayrollReport",
            `Sent scheduled report to ${schedule.email}`,
            {
              scheduleId: schedule.id,
              employerId: schedule.employerId,
              frequency: schedule.frequency,
              ipfsUrl,
            },
          );
        } else {
          await serviceLogger.error(
            "PayrollReport",
            `All ${MAX_RETRIES} delivery attempts failed for schedule ${schedule.id}`,
            new Error("Email delivery failed after retries"),
            { scheduleId: schedule.id, employerId: schedule.employerId },
          );
        }
      } catch (error: any) {
        await serviceLogger.error(
          "PayrollReport",
          `Failed to generate report for schedule ${schedule.id}`,
          error,
          {
            scheduleId: schedule.id,
            employerId: schedule.employerId,
          },
        );
      }
    }
  } catch (error: any) {
    await serviceLogger.error(
      "PayrollReport",
      "Failed to process scheduled reports",
      error,
    );
  }
};

let reportCronJob: cron.ScheduledTask | null = null;

/**
 * Start the payroll report scheduler
 * Runs daily at midnight to check for due reports
 */
export const startPayrollReportScheduler = (): void => {
  if (reportCronJob) {
    console.log("[PayrollReportScheduler] Already running");
    return;
  }

  reportCronJob = cron.schedule("0 0 * * *", async () => {
    console.log("[PayrollReportScheduler] Processing scheduled reports...");
    await processScheduledReports();
  });

  console.log("[PayrollReportScheduler] Started - runs daily at midnight");
};

/**
 * Stop the payroll report scheduler
 */
export const stopPayrollReportScheduler = (): void => {
  if (reportCronJob) {
    reportCronJob.stop();
    reportCronJob = null;
    console.log("[PayrollReportScheduler] Stopped");
  }
};

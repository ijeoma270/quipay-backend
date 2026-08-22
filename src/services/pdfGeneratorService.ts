import PDFDocument from "pdfkit";
import axios from "axios";
import fs from "fs/promises";
import { generateQRCode } from "./signatureService";
import {
  logServiceInfo,
  logServiceWarn,
  logServiceError,
} from "../audit/serviceLogger";

const DEFAULT_PRIMARY_COLOR = "#2563eb";
const DEFAULT_SECONDARY_COLOR = "#64748b";

export interface StreamRecord {
  stream_id: number;
  employer_address: string;
  worker_address: string;
  total_amount: string;
  withdrawn_amount: string;
  start_ts: number;
  end_ts: number;
  status: string;
  created_at: Date;
}

export interface WithdrawalRecord {
  id: number;
  stream_id: number;
  worker: string;
  amount: string;
  ledger: number;
  ledger_ts: number;
  created_at: Date;
}

export interface BrandingSettings {
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export interface GeneratePayslipParams {
  streamId: number;
  streamData: StreamRecord;
  withdrawals: WithdrawalRecord[];
  branding: BrandingSettings;
  signature: string;
  payslipId: string;
  generatedAt: Date;
}

/**
 * Generate a PDF payslip for a given stream
 */
export async function generatePayslip(
  params: GeneratePayslipParams,
): Promise<Buffer> {
  const {
    streamId,
    streamData,
    withdrawals,
    branding,
    signature,
    payslipId,
    generatedAt,
  } = params;

  logServiceInfo("pdfGenerator", "Generating payslip", {
    streamId,
    payslipId,
    workerAddress: streamData.worker_address,
    employerAddress: streamData.employer_address,
  });

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => {
        logServiceError("pdfGenerator", "PDF generation failed", {
          error: err.message,
          streamId,
          payslipId,
        });
        reject(err);
      });

      // Generate QR code for signature
      let qrCodeBuffer: Buffer | null = null;
      try {
        qrCodeBuffer = await generateQRCode(signature);
      } catch (err) {
        logServiceWarn("pdfGenerator", "QR code generation failed", {
          error: err instanceof Error ? err.message : String(err),
          streamId,
        });
      }

      // Fetch logo if available — try local filesystem first, then HTTP.
      let logoBuffer: Buffer | null = null;
      if (branding.logoUrl) {
        try {
          if (
            branding.logoUrl.startsWith("http://") ||
            branding.logoUrl.startsWith("https://")
          ) {
            const response = await axios.get<ArrayBuffer>(branding.logoUrl, {
              responseType: "arraybuffer",
              timeout: 5000,
            });
            logoBuffer = Buffer.from(response.data);
          } else {
            logoBuffer = await fs.readFile(branding.logoUrl);
          }
          logServiceInfo("pdfGenerator", "Logo fetched successfully", {
            logoUrl: branding.logoUrl,
            streamId,
          });
        } catch (err) {
          logServiceWarn(
            "pdfGenerator",
            "Logo retrieval failed — using default branding",
            {
              error: err instanceof Error ? err.message : String(err),
              logoUrl: branding.logoUrl,
              streamId,
            },
          );
        }
      }

      // Header with branding
      addHeader(doc, branding, logoBuffer);

      // Payslip title
      doc
        .fontSize(20)
        .fillColor(branding.primaryColor)
        .text("PAYSLIP", { align: "center" })
        .moveDown();

      // Payslip metadata
      doc
        .fontSize(10)
        .fillColor("#000000")
        .text(`Payslip ID: ${payslipId}`, { align: "right" })
        .text(`Generated: ${generatedAt.toISOString()}`, { align: "right" })
        .moveDown();

      // Worker and Employer information
      addPartyInformation(doc, streamData, branding);

      // Stream details
      addStreamDetails(doc, streamData, branding);

      // Withdrawal history
      addWithdrawalHistory(doc, withdrawals, branding);

      // Signature section
      addSignatureSection(doc, signature, qrCodeBuffer, branding);

      // Footer
      addFooter(doc);

      doc.end();
    } catch (err) {
      logServiceError(
        "pdfGenerator",
        "Unexpected error during PDF generation",
        {
          error: err instanceof Error ? err.message : String(err),
          streamId,
          payslipId,
        },
      );
      reject(err);
    }
  });
}

function addHeader(
  doc: PDFKit.PDFDocument,
  branding: BrandingSettings,
  logoBuffer: Buffer | null,
): void {
  const effectivePrimary = branding.primaryColor || DEFAULT_PRIMARY_COLOR;
  const effectiveSecondary = branding.secondaryColor || DEFAULT_SECONDARY_COLOR;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, 45, { width: 100 });
    } catch (err) {
      logServiceWarn("pdfGenerator", "Failed to embed logo in PDF", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to text brand name when image embedding fails.
      doc.fontSize(14).fillColor(effectivePrimary).text("Quipay", 50, 50);
    }
  } else {
    // No custom logo — render brand name in primary color.
    doc.fontSize(14).fillColor(effectivePrimary).text("Quipay", 50, 50);
  }

  doc
    .fontSize(12)
    .fillColor(effectiveSecondary)
    .text("Quipay Payment Stream", 200, 50, { align: "right" });

  // Horizontal rule in primary brand color beneath the header.
  doc
    .moveTo(50, 80)
    .lineTo(545, 80)
    .strokeColor(effectivePrimary)
    .lineWidth(1.5)
    .stroke()
    .moveDown(2);
}

function addPartyInformation(
  doc: PDFKit.PDFDocument,
  streamData: StreamRecord,
  branding: BrandingSettings,
): void {
  const startY = doc.y;

  // Worker information (left column)
  doc
    .fontSize(12)
    .fillColor(branding.primaryColor)
    .text("Worker", 50, startY)
    .fontSize(10)
    .fillColor("#000000")
    .text(streamData.worker_address, 50, startY + 20, { width: 200 });

  // Employer information (right column)
  doc
    .fontSize(12)
    .fillColor(branding.primaryColor)
    .text("Employer", 300, startY)
    .fontSize(10)
    .fillColor("#000000")
    .text(streamData.employer_address, 300, startY + 20, { width: 200 });

  doc.moveDown(3);
}

function addStreamDetails(
  doc: PDFKit.PDFDocument,
  streamData: StreamRecord,
  branding: BrandingSettings,
): void {
  doc
    .fontSize(14)
    .fillColor(branding.primaryColor)
    .text("Payment Stream Details")
    .moveDown(0.5);

  const startY = doc.y;
  const leftX = 50;
  const rightX = 300;
  const lineHeight = 20;

  // Left column
  doc
    .fontSize(10)
    .fillColor("#666666")
    .text("Stream ID:", leftX, startY)
    .fillColor("#000000")
    .text(streamData.stream_id.toString(), leftX + 100, startY);

  doc
    .fillColor("#666666")
    .text("Total Amount:", leftX, startY + lineHeight)
    .fillColor("#000000")
    .text(
      formatAmount(streamData.total_amount),
      leftX + 100,
      startY + lineHeight,
    );

  doc
    .fillColor("#666666")
    .text("Withdrawn Amount:", leftX, startY + lineHeight * 2)
    .fillColor("#000000")
    .text(
      formatAmount(streamData.withdrawn_amount),
      leftX + 100,
      startY + lineHeight * 2,
    );

  // Right column
  doc
    .fillColor("#666666")
    .text("Start Date:", rightX, startY)
    .fillColor("#000000")
    .text(formatTimestamp(streamData.start_ts), rightX + 100, startY);

  doc
    .fillColor("#666666")
    .text("End Date:", rightX, startY + lineHeight)
    .fillColor("#000000")
    .text(
      formatTimestamp(streamData.end_ts),
      rightX + 100,
      startY + lineHeight,
    );

  doc
    .fillColor("#666666")
    .text("Status:", rightX, startY + lineHeight * 2)
    .fillColor("#000000")
    .text(streamData.status, rightX + 100, startY + lineHeight * 2);

  doc.moveDown(3);
}

function addWithdrawalHistory(
  doc: PDFKit.PDFDocument,
  withdrawals: WithdrawalRecord[],
  branding: BrandingSettings,
): void {
  doc
    .fontSize(14)
    .fillColor(branding.primaryColor)
    .text("Withdrawal History")
    .moveDown(0.5);

  if (withdrawals.length === 0) {
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text("No withdrawals recorded")
      .moveDown(2);
    return;
  }

  // Table header
  const tableTop = doc.y;
  const colWidths = { date: 120, amount: 120, ledger: 120 };
  const leftMargin = 50;

  doc
    .fontSize(10)
    .fillColor("#FFFFFF")
    .rect(leftMargin, tableTop, 495, 20)
    .fill(branding.primaryColor);

  doc
    .fillColor("#FFFFFF")
    .text("Date", leftMargin + 5, tableTop + 5, { width: colWidths.date })
    .text("Amount", leftMargin + colWidths.date + 5, tableTop + 5, {
      width: colWidths.amount,
    })
    .text(
      "Ledger",
      leftMargin + colWidths.date + colWidths.amount + 5,
      tableTop + 5,
      {
        width: colWidths.ledger,
      },
    );

  // Table rows
  let currentY = tableTop + 25;
  withdrawals.forEach((withdrawal, index) => {
    const bgColor = index % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
    doc.rect(leftMargin, currentY, 495, 20).fill(bgColor);

    doc
      .fillColor("#000000")
      .text(
        formatTimestamp(withdrawal.ledger_ts),
        leftMargin + 5,
        currentY + 5,
        {
          width: colWidths.date,
        },
      )
      .text(
        formatAmount(withdrawal.amount),
        leftMargin + colWidths.date + 5,
        currentY + 5,
        { width: colWidths.amount },
      )
      .text(
        withdrawal.ledger.toString(),
        leftMargin + colWidths.date + colWidths.amount + 5,
        currentY + 5,
        { width: colWidths.ledger },
      );

    currentY += 20;
  });

  doc.y = currentY + 10;
  doc.moveDown(2);
}

function addSignatureSection(
  doc: PDFKit.PDFDocument,
  signature: string,
  qrCodeBuffer: Buffer | null,
  branding: BrandingSettings,
): void {
  doc
    .fontSize(14)
    .fillColor(branding.primaryColor)
    .text("Cryptographic Signature")
    .moveDown(0.5);

  if (!signature) {
    doc
      .fontSize(10)
      .fillColor("#DC2626")
      .text("Signature unavailable")
      .moveDown(2);
    return;
  }

  // QR code
  if (qrCodeBuffer) {
    try {
      doc.image(qrCodeBuffer, 50, doc.y, { width: 100 });
    } catch (err) {
      logServiceWarn("pdfGenerator", "Failed to embed QR code in PDF", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Signature text
  doc
    .fontSize(8)
    .fillColor("#000000")
    .text("Signature:", 170, doc.y)
    .text(signature, 170, doc.y + 15, { width: 350 })
    .moveDown(2);

  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(
      "This payslip is cryptographically signed. Verify authenticity at /verify-signature",
      50,
      doc.y,
      { width: 495, align: "center" },
    )
    .moveDown();
}

function addFooter(doc: PDFKit.PDFDocument): void {
  const pageHeight = doc.page.height;
  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(
      "This is a computer-generated document. No signature is required.",
      50,
      pageHeight - 50,
      { align: "center", width: 495 },
    );
}

function formatAmount(amount: string): string {
  // Convert stroops to XLM (1 XLM = 10,000,000 stroops)
  const xlm = parseFloat(amount) / 10000000;
  return `${xlm.toFixed(7)} XLM`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split("T")[0];
}

// ── Payroll Report PDF ──────────────────────────────────────────────────────

export interface PayrollReportPdfData {
  employerId: string;
  periodStart: Date;
  periodEnd: Date;
  totalPaid: string;
  activeStreams: number;
  completedStreams: number;
  workers: Array<{
    workerAddress: string;
    totalReceived: string;
    streamCount: number;
  }>;
  vaultActivity: {
    totalDeposits: string;
    totalDisbursed: string;
    currentBalance: string;
  };
  streamEvents: Array<{
    eventType: string;
    streamId: number;
    workerAddress: string;
    timestamp: Date;
  }>;
}

/**
 * Generate a payroll report PDF summarizing an employer's payroll activity.
 */
export async function generatePayrollReport(
  report: PayrollReportPdfData,
  branding: BrandingSettings,
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Fetch logo
      let logoBuffer: Buffer | null = null;
      if (branding.logoUrl) {
        try {
          if (
            branding.logoUrl.startsWith("http://") ||
            branding.logoUrl.startsWith("https://")
          ) {
            const response = await axios.get<ArrayBuffer>(branding.logoUrl, {
              responseType: "arraybuffer",
              timeout: 5000,
            });
            logoBuffer = Buffer.from(response.data);
          } else {
            logoBuffer = await fs.readFile(branding.logoUrl);
          }
        } catch {
          // Logo fetch failed — continue without it
        }
      }

      const primary = branding.primaryColor || DEFAULT_PRIMARY_COLOR;
      const secondary = branding.secondaryColor || DEFAULT_SECONDARY_COLOR;

      // ── Header ──
      addReportHeader(doc, primary, secondary, logoBuffer, report);

      // ── Summary Section ──
      addReportSummary(doc, report, primary);

      // ── Payouts Table ──
      addPayoutsTable(doc, report.workers, primary);

      // ── Vault Activity ──
      addVaultActivity(doc, report.vaultActivity, primary);

      // ── Stream Events ──
      if (report.streamEvents.length > 0) {
        addStreamEvents(doc, report.streamEvents, primary);
      }

      // ── Footer ──
      addReportFooter(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function addReportHeader(
  doc: PDFKit.PDFDocument,
  primary: string,
  secondary: string,
  logoBuffer: Buffer | null,
  report: PayrollReportPdfData,
): void {
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, 45, { width: 80 });
    } catch {
      doc.fontSize(14).fillColor(primary).text("Quipay", 50, 50);
    }
  } else {
    doc.fontSize(14).fillColor(primary).text("Quipay", 50, 50);
  }

  doc
    .fontSize(18)
    .fillColor(primary)
    .text("Payroll Report", 200, 50, { align: "right" });

  doc
    .fontSize(10)
    .fillColor(secondary)
    .text(
      `${report.periodStart.toLocaleDateString()} — ${report.periodEnd.toLocaleDateString()}`,
      200,
      72,
      { align: "right" },
    );

  doc
    .moveTo(50, 95)
    .lineTo(545, 95)
    .strokeColor(primary)
    .lineWidth(1.5)
    .stroke()
    .moveDown(2);
}

function addReportSummary(
  doc: PDFKit.PDFDocument,
  report: PayrollReportPdfData,
  primary: string,
): void {
  doc
    .fontSize(14)
    .fillColor(primary)
    .text("Summary")
    .moveDown(0.5);

  const startY = doc.y;
  const leftX = 50;
  const rightX = 300;
  const lineH = 22;

  const rows: [string, string][] = [
    ["Total Paid", `${formatAmount(report.totalPaid)}`],
    ["Active Streams", report.activeStreams.toString()],
    ["Completed Streams", report.completedStreams.toString()],
    ["Workers Paid", report.workers.length.toString()],
  ];

  rows.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text(label, leftX, y)
      .fillColor("#000000")
      .text(value, leftX + 130, y);
  });

  doc.y = startY + rows.length * lineH + 15;
}

function addPayoutsTable(
  doc: PDFKit.PDFDocument,
  workers: PayrollReportPdfData["workers"],
  primary: string,
): void {
  doc
    .fontSize(14)
    .fillColor(primary)
    .text("Payouts by Worker")
    .moveDown(0.5);

  if (workers.length === 0) {
    doc.fontSize(10).fillColor("#666666").text("No payouts in this period").moveDown(2);
    return;
  }

  const tableTop = doc.y;
  const leftMargin = 50;
  const cols = { worker: 200, amount: 150, streams: 145 };

  // Header row
  doc
    .fontSize(10)
    .fillColor("#FFFFFF")
    .rect(leftMargin, tableTop, 495, 20)
    .fill(primary);

  doc
    .fillColor("#FFFFFF")
    .text("Worker", leftMargin + 5, tableTop + 5, { width: cols.worker })
    .text("Total Received", leftMargin + cols.worker + 5, tableTop + 5, {
      width: cols.amount,
    })
    .text(
      "Streams",
      leftMargin + cols.worker + cols.amount + 5,
      tableTop + 5,
      { width: cols.streams },
    );

  let currentY = tableTop + 25;
  workers.forEach((w, i) => {
    const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
    doc.rect(leftMargin, currentY, 495, 20).fill(bg);

    const shortAddr = `${w.workerAddress.slice(0, 6)}…${w.workerAddress.slice(-4)}`;
    doc
      .fillColor("#000000")
      .text(shortAddr, leftMargin + 5, currentY + 5, { width: cols.worker })
      .text(formatAmount(w.totalReceived), leftMargin + cols.worker + 5, currentY + 5, {
        width: cols.amount,
      })
      .text(
        w.streamCount.toString(),
        leftMargin + cols.worker + cols.amount + 5,
        currentY + 5,
        { width: cols.streams },
      );

    currentY += 20;
  });

  doc.y = currentY + 15;
}

function addVaultActivity(
  doc: PDFKit.PDFDocument,
  vault: PayrollReportPdfData["vaultActivity"],
  primary: string,
): void {
  doc
    .fontSize(14)
    .fillColor(primary)
    .text("Vault Activity")
    .moveDown(0.5);

  const startY = doc.y;
  const leftX = 50;
  const lineH = 22;

  const rows: [string, string][] = [
    ["Deposits Received", formatAmount(vault.totalDeposits)],
    ["Total Disbursed", formatAmount(vault.totalDisbursed)],
    ["Current Balance", formatAmount(vault.currentBalance)],
  ];

  rows.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text(label, leftX, y)
      .fillColor("#000000")
      .text(value, leftX + 150, y);
  });

  doc.y = startY + rows.length * lineH + 15;
}

function addStreamEvents(
  doc: PDFKit.PDFDocument,
  events: PayrollReportPdfData["streamEvents"],
  primary: string,
): void {
  doc
    .fontSize(14)
    .fillColor(primary)
    .text("Stream Events")
    .moveDown(0.5);

  const tableTop = doc.y;
  const leftMargin = 50;
  const cols = { date: 120, event: 120, stream: 100, worker: 155 };

  doc
    .fontSize(10)
    .fillColor("#FFFFFF")
    .rect(leftMargin, tableTop, 495, 20)
    .fill(primary);

  doc
    .fillColor("#FFFFFF")
    .text("Date", leftMargin + 5, tableTop + 5, { width: cols.date })
    .text("Event", leftMargin + cols.date + 5, tableTop + 5, { width: cols.event })
    .text(
      "Stream ID",
      leftMargin + cols.date + cols.event + 5,
      tableTop + 5,
      { width: cols.stream },
    )
    .text(
      "Worker",
      leftMargin + cols.date + cols.event + cols.stream + 5,
      tableTop + 5,
      { width: cols.worker },
    );

  let currentY = tableTop + 25;
  events.forEach((e, i) => {
    const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
    doc.rect(leftMargin, currentY, 495, 20).fill(bg);

    const shortAddr = `${e.workerAddress.slice(0, 6)}…${e.workerAddress.slice(-4)}`;
    doc
      .fillColor("#000000")
      .text(e.timestamp.toLocaleDateString(), leftMargin + 5, currentY + 5, {
        width: cols.date,
      })
      .text(e.eventType, leftMargin + cols.date + 5, currentY + 5, {
        width: cols.event,
      })
      .text(
        e.streamId.toString(),
        leftMargin + cols.date + cols.event + 5,
        currentY + 5,
        { width: cols.stream },
      )
      .text(
        shortAddr,
        leftMargin + cols.date + cols.event + cols.stream + 5,
        currentY + 5,
        { width: cols.worker },
      );

    currentY += 20;
  });

  doc.y = currentY + 15;
}

function addReportFooter(doc: PDFKit.PDFDocument): void {
  const pageHeight = doc.page.height;
  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(
      "Generated by Quipay Payroll System — This is a computer-generated document.",
      50,
      pageHeight - 50,
      { align: "center", width: 495 },
    );
}

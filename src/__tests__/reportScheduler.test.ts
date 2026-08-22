import {
  generateAndSendReport,
  processScheduledReports,
} from "../scheduler/reportScheduler";
import * as reportDataService from "../services/reportDataService";
import * as pdfGeneratorService from "../services/pdfGeneratorService";
import * as brandingService from "../services/brandingService";
import * as ipfsService from "../services/ipfsService";
import * as reportEmail from "../templates/reportEmail";
import * as payrollReportService from "../services/payrollReportService";
import * as payrollReportScheduleDb from "../db/payrollReportSchedule";
import * as serviceLogger from "../audit/serviceLogger";

jest.mock("../services/reportDataService");
jest.mock("../services/pdfGeneratorService");
jest.mock("../services/brandingService");
jest.mock("../services/ipfsService");
jest.mock("../templates/reportEmail");
jest.mock("../services/payrollReportService");
jest.mock("../db/payrollReportSchedule");
jest.mock("../audit/serviceLogger", () => ({
  serviceLogger: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockReportData = {
  employerId: "emp-1",
  periodStart: new Date("2026-01-01"),
  periodEnd: new Date("2026-01-31"),
  totalPaid: "1000000000",
  activeStreams: 3,
  completedStreams: 5,
  workers: [
    { workerAddress: "GABC123", totalReceived: "500000000", streamCount: 2 },
  ],
  vaultActivity: {
    totalDeposits: "2000000000",
    totalDisbursed: "1000000000",
    currentBalance: "1000000000",
  },
  streamEvents: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  (reportDataService.generateReportData as jest.Mock).mockResolvedValue(
    mockReportData,
  );
  (brandingService.getBrandingForEmployer as jest.Mock).mockResolvedValue({
    logoUrl: null,
    primaryColor: "#2563eb",
    secondaryColor: "#64748b",
  });
  (pdfGeneratorService.generatePayrollReport as jest.Mock).mockResolvedValue(
    Buffer.from("pdf"),
  );
  (ipfsService.pinProofToIPFS as jest.Mock).mockResolvedValue({
    gatewayUrl: "https://ipfs.io/ipfs/QmTest",
  });
  (reportEmail.renderPayrollReportEmail as jest.Mock).mockReturnValue({
    subject: "Test Report",
    html: "<p>Test</p>",
  });
});

describe("generateAndSendReport", () => {
  it("generates report data, PDF, pins to IPFS, and sends email", async () => {
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(result.ipfsUrl).toContain("ipfs");
    expect(reportDataService.generateReportData).toHaveBeenCalledWith(
      "emp-1",
      expect.any(Date),
      expect.any(Date),
    );
    expect(pdfGeneratorService.generatePayrollReport).toHaveBeenCalled();
    expect(
      payrollReportService.sendReportEmailWithAttachment,
    ).toHaveBeenCalledWith(
      "test@example.com",
      "Test Report",
      "<p>Test</p>",
      expect.any(Buffer),
    );
  });

  it("returns sent=false when all retries fail", async () => {
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockRejectedValue(new Error("SMTP error"));

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "weekly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(false);
    expect(
      payrollReportService.sendReportEmailWithAttachment,
    ).toHaveBeenCalledTimes(3);
  });

  it("skips PDF generation when format is csv", async () => {
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "csv",
    );

    expect(pdfGeneratorService.generatePayrollReport).not.toHaveBeenCalled();
    expect(
      payrollReportService.sendReportEmailWithAttachment,
    ).toHaveBeenCalledWith(
      "test@example.com",
      "Test Report",
      "<p>Test</p>",
      null,
    );
  });

  it("continues when IPFS pinning fails", async () => {
    (ipfsService.pinProofToIPFS as jest.Mock).mockRejectedValue(
      new Error("IPFS down"),
    );
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(result.ipfsUrl).toBeUndefined();
  });

  it("uses fallback branding when branding service fails", async () => {
    (brandingService.getBrandingForEmployer as jest.Mock).mockRejectedValue(
      new Error("not found"),
    );
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    const result = await generateAndSendReport(
      "emp-1",
      "test@example.com",
      "monthly",
      ["summary"],
      "pdf",
    );

    expect(result.sent).toBe(true);
    expect(pdfGeneratorService.generatePayrollReport).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ primaryColor: "#2563eb" }),
    );
  });
});

describe("processScheduledReports", () => {
  it("processes each due schedule and updates lastSentAt", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([
      {
        id: 1,
        employerId: "emp-1",
        email: "a@b.com",
        frequency: "monthly",
        includeSections: ["summary"],
        format: "pdf",
      },
      {
        id: 2,
        employerId: "emp-2",
        email: "c@d.com",
        frequency: "weekly",
        includeSections: ["summary"],
        format: "pdf",
      },
    ]);
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    await processScheduledReports();

    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).toHaveBeenCalledTimes(2);
  });

  it("logs error when report generation fails but continues processing", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([
      { id: 1, employerId: "emp-1", email: "a@b.com", frequency: "monthly" },
      { id: 2, employerId: "emp-2", email: "c@d.com", frequency: "weekly" },
    ]);
    (reportDataService.generateReportData as jest.Mock)
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce(mockReportData);
    (
      payrollReportService.sendReportEmailWithAttachment as jest.Mock
    ).mockResolvedValue(true);

    await processScheduledReports();

    expect(serviceLogger.serviceLogger.error).toHaveBeenCalledWith(
      "PayrollReport",
      expect.stringContaining("Failed to generate report"),
      expect.any(Error),
      expect.objectContaining({ scheduleId: 1 }),
    );
    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).toHaveBeenCalledTimes(1);
  });

  it("handles empty schedule list gracefully", async () => {
    (
      payrollReportScheduleDb.getEnabledSchedulesDue as jest.Mock
    ).mockResolvedValue([]);

    await processScheduledReports();

    expect(
      payrollReportScheduleDb.updateReportScheduleLastSent,
    ).not.toHaveBeenCalled();
  });
});

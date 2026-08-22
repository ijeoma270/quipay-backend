import { PayrollReportData } from "../services/reportDataService";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const formatTokens = (amount: string): string => {
  const num = parseFloat(amount);
  return Number.isFinite(num) ? (num / 1e7).toFixed(2) : "0.00";
};

const baseLayout = (title: string, body: string): string => `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.5; max-width: 600px; margin: 0 auto;">
    <div style="background: #2563eb; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <h1 style="margin: 0; font-size: 20px;">${escapeHtml(title)}</h1>
    </div>
    <div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
      ${body}
    </div>
    <div style="background: #f9fafb; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; font-size: 12px; color: #6b7280;">
      <p style="margin: 0 0 4px;">This is an automated report from Quipay Payroll System.</p>
      <p style="margin: 0;">To unsubscribe, contact your administrator or adjust your schedule settings.</p>
    </div>
  </div>
`;

export const renderPayrollReportEmail = (
  report: PayrollReportData,
  ipfsUrl?: string,
): { subject: string; html: string } => {
  const periodLabel = `${report.periodStart.toLocaleDateString()} — ${report.periodEnd.toLocaleDateString()}`;

  const workerRows = report.workers
    .map(
      (w) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-family: monospace; font-size: 13px;">
          ${escapeHtml(`${w.workerAddress.slice(0, 6)}…${w.workerAddress.slice(-4)}`)}
        </td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-align: right;">
          ${escapeHtml(formatTokens(w.totalReceived))} XLM
        </td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f3f4f6; text-align: center;">
          ${w.streamCount}
        </td>
      </tr>
    `,
    )
    .join("");

  const body = `
    <p style="color: #374151; margin: 0 0 16px;">
      Here is your payroll summary for <strong>${escapeHtml(periodLabel)}</strong>.
    </p>

    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; margin: 0 0 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Total Paid</td>
          <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #111827;">
            ${escapeHtml(formatTokens(report.totalPaid))} XLM
          </td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Active Streams</td>
          <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #111827;">
            ${report.activeStreams}
          </td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Completed Streams</td>
          <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #111827;">
            ${report.completedStreams}
          </td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #6b7280; font-size: 13px;">Workers Paid</td>
          <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #111827;">
            ${report.workers.length}
          </td>
        </tr>
      </table>
    </div>

    ${
      report.workers.length > 0
        ? `
    <h3 style="font-size: 14px; color: #374151; margin: 0 0 8px;">Worker Payouts</h3>
    <table style="width: 100%; border-collapse: collapse; margin: 0 0 20px;">
      <thead>
        <tr style="background: #2563eb; color: white;">
          <th style="padding: 8px 12px; text-align: left; font-size: 12px; font-weight: 600;">Worker</th>
          <th style="padding: 8px 12px; text-align: right; font-size: 12px; font-weight: 600;">Amount</th>
          <th style="padding: 8px 12px; text-align: center; font-size: 12px; font-weight: 600;">Streams</th>
        </tr>
      </thead>
      <tbody>
        ${workerRows}
      </tbody>
    </table>
    `
        : '<p style="color: #9ca3af; font-style: italic;">No payouts recorded in this period.</p>'
    }

    ${
      ipfsUrl
        ? `
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin: 0 0 16px;">
      <p style="margin: 0; font-size: 13px; color: #166534;">
        <strong>IPFS Archive:</strong>
        <a href="${escapeHtml(ipfsUrl)}" style="color: #2563eb; text-decoration: underline;">${escapeHtml(ipfsUrl)}</a>
      </p>
    </div>
    `
        : ""
    }

    <p style="color: #9ca3af; font-size: 12px; margin: 16px 0 0;">
      The full PDF report is attached to this email.
    </p>
  `;

  return {
    subject: `Payroll Report — ${periodLabel}`,
    html: baseLayout("Payroll Report", body),
  };
};

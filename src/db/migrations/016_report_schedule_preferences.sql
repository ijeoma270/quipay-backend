-- Add report format and section preferences to payroll_report_schedules
-- Supports PDF, CSV, or both formats; configurable report sections

ALTER TABLE payroll_report_schedules
  ADD COLUMN IF NOT EXISTS day_of_month INTEGER,
  ADD COLUMN IF NOT EXISTS day_of_week INTEGER,
  ADD COLUMN IF NOT EXISTS include_sections TEXT[] NOT NULL DEFAULT '{"summary","streams","withdrawals","vault_balance"}',
  ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'pdf';

-- Constraint: format must be pdf, csv, or both
ALTER TABLE payroll_report_schedules
  ADD CONSTRAINT prs_format_check CHECK (format IN ('pdf', 'csv', 'both'));

-- Constraint: day_of_month between 1 and 31
ALTER TABLE payroll_report_schedules
  ADD CONSTRAINT prs_day_of_month_check CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31));

-- Constraint: day_of_week between 0 and 6
ALTER TABLE payroll_report_schedules
  ADD CONSTRAINT prs_day_of_week_check CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6));

import express from "express";
import request from "supertest";
import { reportsRouter } from "../routes/reports";
import * as reportScheduleDb from "../db/payrollReportSchedule";
import * as reportScheduler from "../scheduler/reportScheduler";

jest.mock("../db/payrollReportSchedule");
jest.mock("../scheduler/reportScheduler");
jest.mock("../middleware/rbac", () => ({
  authenticateRequest: (req: any, _res: any, next: any) => {
    req.user = {
      id: req.headers["x-user-id"] || "owner-1",
      role: 1,
    };
    next();
  },
  requireUser: (_req: any, _res: any, next: any) => next(),
}));

const app = express();
app.use(express.json());
app.use("/reports", reportsRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /reports/schedule", () => {
  it("creates a schedule with valid input", async () => {
    const mockSchedule = {
      id: 1,
      employerId: "owner-1",
      frequency: "monthly",
      email: "test@example.com",
      includeSections: ["summary", "streams"],
      format: "pdf",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (reportScheduleDb.createReportSchedule as jest.Mock).mockResolvedValue(
      mockSchedule,
    );

    const res = await request(app)
      .post("/reports/schedule")
      .send({
        frequency: "monthly",
        email: "test@example.com",
        includeSections: ["summary", "streams"],
      });

    expect(res.status).toBe(201);
    expect(res.body.schedule.id).toBe(1);
    expect(reportScheduleDb.createReportSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: "monthly",
        email: "test@example.com",
      }),
    );
  });

  it("returns 400 for missing fields", async () => {
    const res = await request(app)
      .post("/reports/schedule")
      .send({ frequency: "monthly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required fields");
  });

  it("returns 400 for invalid frequency", async () => {
    const res = await request(app)
      .post("/reports/schedule")
      .send({ frequency: "daily", email: "test@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid frequency");
  });

  it("returns 400 for invalid email", async () => {
    const res = await request(app)
      .post("/reports/schedule")
      .send({ frequency: "weekly", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid email");
  });
});

describe("GET /reports/schedule", () => {
  it("returns schedules for the employer", async () => {
    const mockSchedules = [
      { id: 1, employerId: "owner-1", frequency: "weekly", email: "a@b.com" },
      { id: 2, employerId: "owner-1", frequency: "monthly", email: "c@d.com" },
    ];
    (
      reportScheduleDb.getReportSchedulesByEmployer as jest.Mock
    ).mockResolvedValue(mockSchedules);

    const res = await request(app).get("/reports/schedule");

    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(2);
  });
});

describe("DELETE /reports/schedule/:id", () => {
  it("deletes when caller is the owner", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 7,
      employerId: "owner-1",
      frequency: "weekly",
      email: "owner@example.com",
    });
    (reportScheduleDb.deleteReportSchedule as jest.Mock).mockResolvedValue({
      id: 7,
      employerId: "owner-1",
    });

    const res = await request(app)
      .delete("/reports/schedule/7")
      .set("x-user-id", "owner-1");

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("deleted");
  });

  it("returns 403 when caller is not the owner", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 7,
      employerId: "owner-1",
      frequency: "weekly",
      email: "owner@example.com",
    });

    const res = await request(app)
      .delete("/reports/schedule/7")
      .set("x-user-id", "not-owner");

    expect(res.status).toBe(403);
    expect(reportScheduleDb.deleteReportSchedule).not.toHaveBeenCalled();
  });

  it("returns 404 when schedule does not exist", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue(
      null,
    );

    const res = await request(app).delete("/reports/schedule/999");

    expect(res.status).toBe(404);
  });
});

describe("PUT /reports/schedule/:id", () => {
  it("updates a schedule", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "owner-1",
    });
    (reportScheduleDb.updateReportSchedule as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "owner-1",
      frequency: "weekly",
      email: "new@example.com",
    });

    const res = await request(app)
      .put("/reports/schedule/1")
      .send({ email: "new@example.com", frequency: "weekly" });

    expect(res.status).toBe(200);
    expect(res.body.schedule.email).toBe("new@example.com");
  });

  it("returns 404 for non-owned schedule", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "other-owner",
    });

    const res = await request(app)
      .put("/reports/schedule/1")
      .set("x-user-id", "owner-1")
      .send({ email: "x@y.com" });

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid frequency", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "owner-1",
    });

    const res = await request(app)
      .put("/reports/schedule/1")
      .send({ frequency: "hourly" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid frequency");
  });
});

describe("POST /reports/schedule/:id/test", () => {
  it("sends a test report successfully", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "owner-1",
      frequency: "monthly",
      email: "test@example.com",
      includeSections: ["summary"],
      format: "pdf",
    });
    (reportScheduler.generateAndSendReport as jest.Mock).mockResolvedValue({
      sent: true,
      ipfsUrl: "https://ipfs.io/ipfs/Qm123",
    });

    const res = await request(app).post("/reports/schedule/1/test");

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.ipfsUrl).toContain("ipfs");
  });

  it("reports when email delivery fails", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "owner-1",
      frequency: "weekly",
      email: "test@example.com",
    });
    (reportScheduler.generateAndSendReport as jest.Mock).mockResolvedValue({
      sent: false,
    });

    const res = await request(app).post("/reports/schedule/1/test");

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(false);
    expect(res.body.message).toContain("delivery failed");
  });

  it("returns 404 for non-owned schedule", async () => {
    (reportScheduleDb.getReportScheduleById as jest.Mock).mockResolvedValue({
      id: 1,
      employerId: "other-owner",
    });

    const res = await request(app)
      .post("/reports/schedule/1/test")
      .set("x-user-id", "owner-1");

    expect(res.status).toBe(404);
  });
});

import express from "express";
import * as dotenv from "dotenv";
import { API_KEY, getQuotaStatusAsync } from "./utils.js";

// Import API handlers for local development
import collabHandler from "./api/collab.js";
import growthHandler from "./api/growth.js";
import unlistedHandler from "./api/unlisted.js";
import analyzeHandler from "./api/analyze.js";
import domainHandler from "./api/domain.js";
import quotaHandler from "./api/quota.js";
import compareHandler from "./api/compare.js";
import revenueHandler from "./api/revenue.js";
import predictorHandler from "./api/predictor.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.warn("[WARN] No YOUTUBE_API_KEY found in environment. Set it in your .env file.");
}

app.use(express.static("public", { extensions: ["html"] }));

app.use((req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const requestId = (typeof incoming === "string" && incoming.trim())
    ? incoming.trim()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), requestId: req.requestId });
});

app.get("/health/live", (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ status: "down", error: "YOUTUBE_API_KEY missing", requestId: req.requestId });
  }
  res.json({ status: "alive", requestId: req.requestId });
});

app.get("/health/ready", async (req, res) => {
  try {
    const quotaStatus = await getQuotaStatusAsync();
    res.json({
      status: quotaStatus.isExhausted ? "degraded" : "ready",
      quotaRemaining: quotaStatus.usableRemaining,
      requestId: req.requestId
    });
  } catch (err) {
    res.status(503).json({ status: "not-ready", error: err.message, requestId: req.requestId });
  }
});

// Register API routes for local development
app.get("/api/analyze", analyzeHandler);
app.get("/api/collab", collabHandler);
app.get("/api/growth", growthHandler);
app.get("/api/unlisted", unlistedHandler);
app.get("/api/domain", domainHandler);
app.get("/api/quota", quotaHandler);
app.get("/api/compare", compareHandler);
app.get("/api/revenue", revenueHandler);
app.get("/api/predictor", predictorHandler);

app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    msg: "express_unhandled_error",
    requestId: req?.requestId,
    error: err?.message,
    stack: err?.stack
  }));
  if (res.headersSent) return next(err);
  return res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    requestId: req?.requestId
  });
});

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

export default app;
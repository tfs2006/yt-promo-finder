import { getQuotaStatusAsync } from "../utils.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const quotaStatus = await getQuotaStatusAsync();
    return res.status(200).json({
      status: quotaStatus.isExhausted ? "degraded" : "ready",
      quotaRemaining: quotaStatus.usableRemaining,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: "not-ready",
      error: err.message || "Quota check failed"
    });
  }
}

import { getQuotaStatusAsync, applyApiGuards, initQuota, handleApiError } from "../utils.js";

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "quota", maxRequests: 90, windowMs: 60_000 })) return;

  // Initialize quota from persistent storage
  await initQuota();

  try {
    const status = await getQuotaStatusAsync();
    res.json(status);
  } catch (err) {
    return handleApiError(res, err, req);
  }
}

import { getQuotaStatus, setCorsHeaders } from "../utils.js";

export default async function handler(req, res) {
  setCorsHeaders(res);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const status = getQuotaStatus();
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get quota status." });
  }
}

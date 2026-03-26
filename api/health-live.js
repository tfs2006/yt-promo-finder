import { API_KEY } from "../utils.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!API_KEY) {
    return res.status(503).json({
      status: "down",
      error: "YOUTUBE_API_KEY missing"
    });
  }

  return res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString()
  });
}

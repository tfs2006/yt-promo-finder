import { handleSmmProfitDashboard } from "../lib/smmHandlers.js";

export default async function handler(req, res) {
  return handleSmmProfitDashboard(req, res);
}

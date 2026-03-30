import { handleSmmOrderStatus } from "../lib/smmHandlers.js";

export default async function handler(req, res) {
  return handleSmmOrderStatus(req, res);
}

import { handleSmmServices } from "../lib/smmHandlers.js";

export default async function handler(req, res) {
  return handleSmmServices(req, res);
}

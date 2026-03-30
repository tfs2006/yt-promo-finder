import { handleSmmCreateCheckout } from "../lib/smmHandlers.js";

export default async function handler(req, res) {
  return handleSmmCreateCheckout(req, res);
}

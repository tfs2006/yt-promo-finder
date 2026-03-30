import { handleStripeWebhook } from "../lib/smmHandlers.js";

export default async function handler(req, res) {
  return handleStripeWebhook(req, res);
}

// Stripe webhook endpoint for PromoFinder.
//
// Stripe signature verification needs the EXACT raw bytes Stripe signed.
// Vercel parses JSON bodies before the handler runs, so a handler that
// re-serializes req.body can fail verification whenever the bytes differ.
// This function disables Vercel's body parser so handleStripeWebhook reads
// the pristine raw stream instead (see getRawBody in lib/smmHandlers.js).
//
// The webhook serves the SMM services flow only (checkout.session.completed
// -> submit the provider order). PromoFinder credit packs do NOT use it:
// they auto-claim on the post-checkout credits page. Program My County
// orders hit this endpoint too (shared Stripe account) and are safely
// ignored here; they are fulfilled by the order watch.
import { handleStripeWebhook } from "../lib/smmHandlers.js";

export const config = { api: { bodyParser: false } };

export default function handler(req, res) {
  return handleStripeWebhook(req, res);
}

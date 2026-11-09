// Regression tests for the Stripe webhook signature verification on Vercel.
//
// Root cause (Nov 9 2026): on Vercel (@vercel/node) the runtime buffers the
// request body and exposes req.body as a LAZILY-PARSED object, so the old
// getRawBody re-serialized it with JSON.stringify instead of using the exact
// bytes Stripe signed. Re-serialization is not byte-identical (Stripe's
// encoder escapes & as \u0026, whitespace differs), so every delivery 500d
// with "No signatures found matching the expected signature" even though the
// secret was correct. The fix reads the raw bytes off the request stream
// with direct read() calls before req.body is ever touched.
//
// These tests simulate the Vercel runtime faithfully: the body is buffered,
// the stream is replayed through a PassThrough (restoreBody), and req.body
// is a lazy getter that JSON.parses on first access, exactly as
// @vercel/node's addHelpers does. No network, no real secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import Stripe from "stripe";
import { handleStripeWebhook } from "../lib/smmHandlers.js";

process.env.STRIPE_SECRET_KEY =
  "sk_test_51H7qK2eZvKYlo2C0000000000000000000000000000000000000000";
const TEST_SECRET =
  "whsec_testsecret0123456789abcdef0123456789abcdef0123456789abcdef";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Minimal, faithful copy of the @vercel/node request preparation ---
// (addHelpers + getBodyParser + restoreBody, for application/json only).
function getBodyParser(body, contentType) {
  return function parseBody() {
    const type = String(contentType || "text/plain")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type === "application/json") {
      const str = body.toString();
      return str ? JSON.parse(str) : {};
    }
    return void 0;
  };
}

function setLazyProp(req, prop, getter) {
  const opts = { configurable: true, enumerable: true };
  const optsReset = { ...opts, writable: true };
  Object.defineProperty(req, prop, {
    ...opts,
    get: () => {
      const value = getter();
      Object.defineProperty(req, prop, { ...optsReset, value });
      return value;
    },
    set: (value) => {
      Object.defineProperty(req, prop, { ...optsReset, value });
    },
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function addVercelHelpers(req) {
  const contentType = req.headers["content-type"];
  const body =
    contentType === void 0
      ? Buffer.from("")
      : (await streamToBuffer(req)) || Buffer.from("");
  // restoreBody: replay the buffered bytes on the request stream.
  const replay = new PassThrough();
  const on = replay.on.bind(replay);
  const originalOn = req.on.bind(req);
  req.read = replay.read.bind(replay);
  req.on = req.addListener = (name, cb) =>
    name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb);
  replay.write(body);
  replay.end();
  setLazyProp(req, "body", getBodyParser(body, contentType));
}
// --- end Vercel runtime simulation ---

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    getHeader(k) {
      return this.headers[k];
    },
    end() {
      return this;
    },
  };
  return res;
}

// Event object shaped like Ron Tegeler's checkout.session.completed
// delivery. The success_url carries a second query param so the raw bytes
// contain a real "&".
function eventObject(type = "charge.succeeded") {
  return {
    id: "evt_1UXVDtHeryTj98X9t9NnlKSO",
    object: "event",
    api_version: "2025-08-27.basil",
    created: 1762147200,
    data: {
      object: {
        id: "cs_live_b1vleGKuXKH7vQYqeItylgXNlhx8iKU4g56HcQrGd71uekS9ZLGD5UtJn9",
        object: "checkout.session",
        amount_total: 2495,
        currency: "usd",
        customer_details: { email: "rtegeler@gmail.com", name: "Ron Tegeler" },
        metadata: {},
        payment_status: "paid",
        status: "complete",
        success_url:
          "https://promofinder.4ourmedia.com/services-success?session_id=cs_live_b1vleGKuXKH7vQYqeItylgXNlhx8iKU4g56HcQrGd71uekS9ZLGD5UtJn9&source=web",
        url: "https://checkout.stripe.com/c/pay/cs_live_b1vleGKuXKH7vQYqeItylgXNlhx8iKU4g56HcQrGd71uekS9ZLGD5UtJn9",
      },
    },
    livemode: true,
    pending_webhooks: 1,
    request: { id: "req_test123", idempotency_key: null },
    type,
  };
}

// Raw bytes as Stripe's encoder emits them: Go's encoding/json escapes &
// as \u0026, so these bytes do NOT survive a JSON.parse -> JSON.stringify
// round-trip. A handler that re-serializes req.body fails on this payload.
function goEscapedPayload(type) {
  return JSON.stringify(eventObject(type)).replaceAll("&", "\\u0026");
}

async function vercelReq(rawPayload, signature) {
  const req = Readable.from([Buffer.from(rawPayload, "utf8")]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
    "stripe-signature": signature,
  };
  req.url = "/api/stripe-webhook";
  await addVercelHelpers(req);
  return req;
}

test("webhook verifies a real Stripe signature on the Vercel path (non-round-tripping bytes)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  const rawPayload = goEscapedPayload("charge.succeeded");
  // Sanity: this payload really does break a re-serialize round-trip.
  assert.notEqual(JSON.stringify(JSON.parse(rawPayload)), rawPayload);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawPayload,
    secret: TEST_SECRET,
  });
  const req = await vercelReq(rawPayload, signature);
  const res = makeRes();
  await handleStripeWebhook(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
});

test("webhook 500s on a one-character-wrong secret (Vercel path)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET.slice(0, -1) + "X";
  const rawPayload = goEscapedPayload("charge.succeeded");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawPayload,
    secret: TEST_SECRET,
  });
  const req = await vercelReq(rawPayload, signature);
  const res = makeRes();
  await handleStripeWebhook(req, res);
  assert.equal(res.statusCode, 500);
});

test("webhook verifies with an Express-style Buffer body (local dev path)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  const rawPayload = goEscapedPayload("charge.succeeded");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawPayload,
    secret: TEST_SECRET,
  });
  // Local server.js uses express.raw(): stream consumed, req.body is a Buffer.
  const req = Readable.from([]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
    "stripe-signature": signature,
  };
  req.url = "/api/stripe-webhook";
  req.body = Buffer.from(rawPayload, "utf8");
  const res = makeRes();
  await handleStripeWebhook(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
});

test("webhook answers checkout.session.completed with no service_id and no action (Vercel path)", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  const rawPayload = goEscapedPayload("checkout.session.completed");
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: rawPayload,
    secret: TEST_SECRET,
  });
  const req = await vercelReq(rawPayload, signature);
  const res = makeRes();
  await handleStripeWebhook(req, res);
  // Ron's order was already fulfilled manually; the handler returns early
  // with 200 and no action when the session has no service_id.
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
});

test("webhook 400s when the Stripe-Signature header is missing", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
  const rawPayload = goEscapedPayload("charge.succeeded");
  const req = Readable.from([Buffer.from(rawPayload, "utf8")]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.url = "/api/stripe-webhook";
  await addVercelHelpers(req);
  const res = makeRes();
  await handleStripeWebhook(req, res);
  assert.equal(res.statusCode, 400);
});

import Stripe from "stripe";
import {
  applyApiGuards,
  getCache,
  handleApiError,
  kvGet,
  kvSet,
  setCache,
  setCorsHeaders
} from "../utils.js";

const TSMG_API_URL = process.env.TSMG_API_URL || "https://thesocialmediagrowth.com/api/v2";
const TSMG_API_KEY = asString(process.env.TSMG_API_KEY, 500);
const SMM_MARKUP_MULTIPLIER = Number(process.env.SMM_MARKUP_MULTIPLIER || "1.8");
const SMM_FLAT_FEE = Number(process.env.SMM_FLAT_FEE || "0");
const SMM_CURRENCY = (process.env.SMM_CURRENCY || "usd").toLowerCase();
const SMM_ORDER_TTL_SECONDS = Number(process.env.SMM_ORDER_TTL_SECONDS || String(60 * 60 * 24 * 30));
const SMM_PROVIDER_COUPON_CODE = String(process.env.SMM_PROVIDER_COUPON_CODE || "RESELLER").trim();
const SMM_PROVIDER_DISCOUNT_PCT = Math.max(0, Math.min(100, Number(process.env.SMM_PROVIDER_DISCOUNT_PCT || "30")));
const SMM_PROVIDER_DISCOUNT_FACTOR = 1 - (SMM_PROVIDER_DISCOUNT_PCT / 100);
const SMM_RETAIL_PRICE_BASIS = (String(process.env.SMM_RETAIL_PRICE_BASIS || "list").toLowerCase() === "effective")
  ? "effective"
  : "list";
const SMM_DASHBOARD_KEY = asString(process.env.SMM_DASHBOARD_KEY, 300);
const SMM_ALERT_WEBHOOK_URL = asString(process.env.SMM_ALERT_WEBHOOK_URL, 600);
const SMM_ALERT_TELEGRAM_BOT_TOKEN = asString(process.env.SMM_ALERT_TELEGRAM_BOT_TOKEN, 400);
const SMM_ALERT_TELEGRAM_CHAT_ID = asString(process.env.SMM_ALERT_TELEGRAM_CHAT_ID, 120);
const SMM_ALERT_TELEGRAM_THREAD_ID = asString(process.env.SMM_ALERT_TELEGRAM_THREAD_ID, 40);
const SMM_ALERT_ORDER_UPDATES = !["0", "false", "no", "off"].includes(
  asString(process.env.SMM_ALERT_ORDER_UPDATES, 12).toLowerCase()
);
const SMM_ALERT_SOURCE = asString(process.env.SMM_ALERT_SOURCE, 120) || "yt-promo-finder";
const SMM_ALERT_TIMEOUT_MS = Math.max(1000, Math.min(20_000, Number(process.env.SMM_ALERT_TIMEOUT_MS || "3500")));
const SMM_ALERT_COOLDOWN_SECONDS = Math.max(0, Math.min(86_400, Number(process.env.SMM_ALERT_COOLDOWN_SECONDS || "300")));
const SMM_DASHBOARD_ALLOW_QUERY_KEY = ["1", "true", "yes", "on"].includes(
  asString(process.env.SMM_DASHBOARD_ALLOW_QUERY_KEY, 12).toLowerCase()
);
const SMM_ORDER_INDEX_KEY = "smm_orders_index_v1";
const SMM_ORDER_INDEX_MAX = Math.max(200, Math.min(10_000, Number(process.env.SMM_ORDER_INDEX_MAX || "5000")));

let stripeClient = null;

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function asString(value, maxLen = 2000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLen);
}

function asInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function asNumber(value) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function roundMoney(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function amountToCents(amount) {
  const cents = Math.round(amount * 100);
  // Stripe enforces minimum charge amounts by currency in live mode.
  return Math.max(50, cents);
}

function calcStripeFeeEstimate(amount) {
  const normalized = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  if (normalized <= 0) return 0;
  return roundMoney((normalized * 0.029) + 0.3);
}

function toIsoNow() {
  return new Date().toISOString();
}

function getBaseUrl(req) {
  const configured = asString(process.env.APP_BASE_URL, 300);
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  const origin = asString(req?.headers?.origin, 300);
  if (origin) {
    return origin.replace(/\/$/, "");
  }

  const host = asString(req?.headers?.host, 300);
  const proto = asString(req?.headers?.["x-forwarded-proto"], 20) || "https";
  if (host) {
    return `${proto}://${host}`;
  }

  return "http://localhost:3000";
}

function getOrderKey(sessionId) {
  return `smm_order:${sessionId}`;
}

function getProviderOrderKey(providerOrderId) {
  return `smm_provider_order:${providerOrderId}`;
}

function getPaidLikeStatuses() {
  return new Set([
    "paid",
    "submitted",
    "in_progress",
    "completed",
    "partial",
    "canceled",
    "paid_submission_failed"
  ]);
}

function isPaidLikeOrder(order) {
  if (!order) return false;
  if (order.stripePaymentIntent) return true;
  const status = asString(order.status, 80).toLowerCase();
  return getPaidLikeStatuses().has(status);
}

function parseIsoDate(input) {
  const value = asString(input, 80);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getDashboardAuthKey(req) {
  const bearer = asString(req?.headers?.authorization, 500);
  if (bearer.toLowerCase().startsWith("bearer ")) {
    return asString(bearer.slice(7), 300);
  }

  const headerKey = asString(req?.headers?.["x-dashboard-key"], 300);
  if (headerKey) {
    return headerKey;
  }

  if (SMM_DASHBOARD_ALLOW_QUERY_KEY) {
    return asString(req?.query?.key, 300);
  }

  return "";
}

function ensureDashboardAccess(req) {
  if (!SMM_DASHBOARD_KEY) {
    return { ok: false, status: 503, error: "SMM_DASHBOARD_KEY is not configured." };
  }

  const provided = getDashboardAuthKey(req);
  if (!provided || provided !== SMM_DASHBOARD_KEY) {
    return { ok: false, status: 401, error: "Unauthorized dashboard access." };
  }

  return { ok: true };
}

function normalizeService(raw) {
  const serviceId = asInteger(raw?.service);
  const min = asInteger(raw?.min);
  const max = asInteger(raw?.max);
  const rate = asNumber(raw?.rate);

  return {
    serviceId,
    name: asString(raw?.name, 200),
    type: asString(raw?.type, 120),
    category: asString(raw?.category, 120),
    min: min ?? null,
    max: max ?? null,
    rate: rate ?? 0,
    rawRate: asString(raw?.rate, 40)
  };
}

function validatePublicLink(link) {
  try {
    const url = new URL(link);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

async function tsmgRequest(payload) {
  if (!TSMG_API_KEY) {
    throw new Error("TSMG_API_KEY is not configured.");
  }

  const form = new URLSearchParams();
  form.set("key", TSMG_API_KEY);

  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    form.set(key, String(value));
  }

  const response = await fetch(TSMG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`TSMG API returned non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(`TSMG API HTTP ${response.status}.`);
  }

  if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
    throw new Error(`TSMG API error: ${data.error}`);
  }

  return data;
}

async function getNormalizedServices() {
  const cacheKey = "smm_services_v1";
  const mem = getCache(cacheKey);
  if (mem) return mem;

  const kvCached = await kvGet(cacheKey);
  if (Array.isArray(kvCached) && kvCached.length) {
    setCache(cacheKey, kvCached, 1000 * 60 * 10);
    return kvCached;
  }

  const rawServices = await tsmgRequest({ action: "services" });
  if (!Array.isArray(rawServices)) {
    throw new Error("Invalid services payload from TSMG.");
  }

  const normalized = rawServices
    .map(normalizeService)
    .filter((service) => service.serviceId && service.name);

  setCache(cacheKey, normalized, 1000 * 60 * 10);
  await kvSet(cacheKey, normalized, { ex: 600 });

  return normalized;
}

function getTypeRule(type) {
  const normalizedType = type.toLowerCase();

  if (normalizedType.includes("custom comments")) {
    return { required: ["link", "quantity", "comments"] };
  }
  if (normalizedType.includes("mentions with hashtags")) {
    return { required: ["link", "quantity", "usernames", "hashtags"] };
  }
  if (normalizedType.includes("mentions custom list")) {
    return { required: ["link", "usernames"] };
  }
  if (normalizedType.includes("subscriptions")) {
    return { required: ["username", "min", "max", "posts"] };
  }
  if (normalizedType.includes("package")) {
    return { required: ["link"] };
  }

  return { required: ["link", "quantity"] };
}

function buildProviderPayload(service, body) {
  const payload = {
    action: "add",
    service: String(service.serviceId)
  };

  const orderBody = {
    link: asString(body.link, 1000),
    quantity: asInteger(body.quantity),
    comments: asString(body.comments, 4000),
    usernames: asString(body.usernames, 2000),
    hashtags: asString(body.hashtags, 1000),
    username: asString(body.username, 500),
    runs: asInteger(body.runs),
    interval: asInteger(body.interval),
    min: asInteger(body.min),
    max: asInteger(body.max),
    posts: asInteger(body.posts),
    delay: asInteger(body.delay),
    expiry: asInteger(body.expiry)
  };

  const rule = getTypeRule(service.type || "");
  for (const requiredField of rule.required) {
    const value = orderBody[requiredField];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required field for this service type: ${requiredField}`);
    }
  }

  if (orderBody.link && !validatePublicLink(orderBody.link)) {
    throw new Error("Invalid link format. Use a full https:// URL.");
  }

  if (orderBody.quantity !== null) {
    if (orderBody.quantity <= 0) {
      throw new Error("Quantity must be greater than zero.");
    }

    if (service.min !== null && orderBody.quantity < service.min) {
      throw new Error(`Quantity is below minimum (${service.min}).`);
    }

    if (service.max !== null && orderBody.quantity > service.max) {
      throw new Error(`Quantity exceeds maximum (${service.max}).`);
    }
  }

  const allowedFields = [
    "link",
    "quantity",
    "comments",
    "usernames",
    "hashtags",
    "username",
    "runs",
    "interval",
    "min",
    "max",
    "posts",
    "delay",
    "expiry"
  ];

  for (const key of allowedFields) {
    const value = orderBody[key];
    if (value === undefined || value === null || value === "") continue;
    payload[key] = String(value);
  }

  return payload;
}

function calculatePricing(service, providerPayload) {
  const quantity = asInteger(providerPayload.quantity);
  const rate = Number.isFinite(service.rate) ? service.rate : 0;

  let providerListCost;
  if (quantity && quantity > 0) {
    providerListCost = (quantity / 1000) * rate;
  } else {
    providerListCost = rate;
  }

  const providerCost = roundMoney(providerListCost * SMM_PROVIDER_DISCOUNT_FACTOR);
  const retailBasis = SMM_RETAIL_PRICE_BASIS === "effective"
    ? providerCost
    : providerListCost;

  const retail = roundMoney(retailBasis * SMM_MARKUP_MULTIPLIER + SMM_FLAT_FEE);

  return {
    providerListCost: roundMoney(providerListCost),
    providerCost: roundMoney(providerCost),
    retailPrice: retail,
    margin: roundMoney(retail - providerCost),
    quantity: quantity || null,
    providerDiscountPct: SMM_PROVIDER_DISCOUNT_PCT,
    providerCouponCode: SMM_PROVIDER_COUPON_CODE
  };
}

async function parseJsonBody(req) {
  if (req?.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req?.body === "string") {
    return JSON.parse(req.body || "{}");
  }

  if (Buffer.isBuffer(req?.body)) {
    const text = req.body.toString("utf8");
    return JSON.parse(text || "{}");
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw || "{}");
}

async function getRawBody(req) {
  if (Buffer.isBuffer(req?.rawBody)) {
    return req.rawBody;
  }

  if (typeof req?.rawBody === "string") {
    return Buffer.from(req.rawBody, "utf8");
  }

  if (Buffer.isBuffer(req?.body)) {
    return req.body;
  }

  if (typeof req?.body === "string") {
    return Buffer.from(req.body, "utf8");
  }

  if (req?.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body), "utf8");
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function statusFromProvider(providerStatus, currentStatus) {
  const value = asString(providerStatus, 60).toLowerCase();

  if (value.includes("complete")) return "completed";
  if (value.includes("partial")) return "partial";
  if (value.includes("progress") || value.includes("processing")) return "in_progress";
  if (value.includes("cancel")) return "canceled";
  if (value.includes("pending")) return "submitted";

  return currentStatus || "submitted";
}

function shouldSendSubmissionFailureAlert(order) {
  if (!hasAnyAlertChannel()) return false;

  const lastSentAt = parseIsoDate(order?.failedSubmissionAlertSentAt);
  if (!lastSentAt) return true;

  const elapsedMs = Date.now() - lastSentAt.getTime();
  return elapsedMs >= (SMM_ALERT_COOLDOWN_SECONDS * 1000);
}

function hasAnyAlertChannel() {
  return Boolean(SMM_ALERT_WEBHOOK_URL || (SMM_ALERT_TELEGRAM_BOT_TOKEN && SMM_ALERT_TELEGRAM_CHAT_ID));
}

async function postAlertJson(url, payload, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SMM_ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(`${label} returned HTTP ${response.status}.`);
      return false;
    }

    return true;
  } catch (error) {
    const message = asString(error?.message, 300) || "Unknown alert error";
    console.error(`${label} failed: ${message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function buildTelegramAlertPayload(alertPayload) {
  const payload = {
    chat_id: SMM_ALERT_TELEGRAM_CHAT_ID,
    text: alertPayload.text,
    disable_web_page_preview: true
  };

  const threadId = asInteger(SMM_ALERT_TELEGRAM_THREAD_ID);
  if (threadId) {
    payload.message_thread_id = threadId;
  }

  return payload;
}

function buildOrderUpdateAlertPayload(order, eventName) {
  const retail = roundMoney(asNumber(order?.retailPrice) || 0);
  const providerCost = roundMoney(asNumber(order?.providerCost) || 0);
  const margin = roundMoney(retail - providerCost);
  const currency = (asString(order?.currency, 12) || SMM_CURRENCY).toUpperCase();
  const lines = [
    `${eventName} (${SMM_ALERT_SOURCE})`,
    `session=${asString(order?.stripeSessionId, 120) || "unknown"}`,
    `providerOrder=${asString(order?.providerOrderId, 120) || "n/a"}`,
    `service=${asString(order?.serviceName, 240) || "Unknown Service"}`,
    `quantity=${asString(order?.quantity, 40) || "n/a"}`,
    `retail=${currency} ${retail.toFixed(2)}`,
    `providerCost=${currency} ${providerCost.toFixed(2)}`,
    `margin=${currency} ${margin.toFixed(2)}`,
    `customer=${asString(order?.customerEmail, 320) || "n/a"}`,
    `status=${asString(order?.status, 80) || "unknown"}`,
    `time=${toIsoNow()}`
  ];

  return {
    event: eventName,
    source: SMM_ALERT_SOURCE,
    occurredAt: toIsoNow(),
    order: {
      id: asString(order?.id, 120) || null,
      stripeSessionId: asString(order?.stripeSessionId, 120) || null,
      stripePaymentIntent: asString(order?.stripePaymentIntent, 120) || null,
      providerOrderId: asString(order?.providerOrderId, 120) || null,
      serviceId: asInteger(order?.serviceId),
      serviceName: asString(order?.serviceName, 240) || null,
      quantity: asInteger(order?.quantity),
      retailPrice: retail,
      providerCost,
      margin,
      currency,
      customerEmail: asString(order?.customerEmail, 320) || null,
      status: asString(order?.status, 80) || "unknown"
    },
    text: lines.join("\n"),
    content: lines.join("\n")
  };
}

async function sendAlertToConfiguredChannels(payload, labelPrefix) {
  if (!hasAnyAlertChannel()) {
    return false;
  }

  let sent = false;

  if (SMM_ALERT_WEBHOOK_URL) {
    const webhookSent = await postAlertJson(
      SMM_ALERT_WEBHOOK_URL,
      payload,
      `${labelPrefix} webhook`
    );
    sent = sent || webhookSent;
  }

  if (SMM_ALERT_TELEGRAM_BOT_TOKEN && SMM_ALERT_TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${SMM_ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`;
    const telegramPayload = buildTelegramAlertPayload(payload);
    const telegramSent = await postAlertJson(telegramUrl, telegramPayload, `${labelPrefix} telegram`);
    sent = sent || telegramSent;
  }

  return sent;
}

function buildSubmissionFailureAlertPayload(order) {
  const retail = roundMoney(asNumber(order?.retailPrice) || 0);
  const providerCost = roundMoney(asNumber(order?.providerCost) || 0);
  const currency = (asString(order?.currency, 12) || SMM_CURRENCY).toUpperCase();
  const lines = [
    `paid_submission_failed (${SMM_ALERT_SOURCE})`,
    `session=${asString(order?.stripeSessionId, 120) || "unknown"}`,
    `service=${asString(order?.serviceName, 240) || "Unknown Service"}`,
    `quantity=${asString(order?.quantity, 40) || "n/a"}`,
    `retail=${currency} ${retail.toFixed(2)}`,
    `providerCost=${currency} ${providerCost.toFixed(2)}`,
    `error=${asString(order?.providerError, 500) || "Unknown provider error"}`,
    `time=${toIsoNow()}`
  ];

  return {
    event: "paid_submission_failed",
    source: SMM_ALERT_SOURCE,
    occurredAt: toIsoNow(),
    order: {
      id: asString(order?.id, 120) || null,
      stripeSessionId: asString(order?.stripeSessionId, 120) || null,
      stripePaymentIntent: asString(order?.stripePaymentIntent, 120) || null,
      serviceId: asInteger(order?.serviceId),
      serviceName: asString(order?.serviceName, 240) || null,
      quantity: asInteger(order?.quantity),
      retailPrice: retail,
      providerCost,
      currency,
      customerEmail: asString(order?.customerEmail, 320) || null,
      providerError: asString(order?.providerError, 500) || "Unknown provider error"
    },
    text: lines.join("\n"),
    content: lines.join("\n")
  };
}

async function sendSubmissionFailureAlert(order) {
  if (!shouldSendSubmissionFailureAlert(order)) {
    return false;
  }

  const payload = buildSubmissionFailureAlertPayload(order);
  return sendAlertToConfiguredChannels(payload, "Submission failure alert");
}

async function sendOrderUpdateAlert(order, eventName = "order_update") {
  if (!SMM_ALERT_ORDER_UPDATES) return false;
  const payload = buildOrderUpdateAlertPayload(order, eventName);
  return sendAlertToConfiguredChannels(payload, "Order update alert");
}

function sanitizeOrder(order) {
  if (!order) return null;

  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    customerEmail: order.customerEmail,
    serviceId: order.serviceId,
    serviceName: order.serviceName,
    serviceType: order.serviceType,
    category: order.category,
    quantity: order.quantity,
    link: order.link,
    retailPrice: order.retailPrice,
    currency: order.currency,
    stripeSessionId: order.stripeSessionId,
    stripePaymentIntent: order.stripePaymentIntent,
    providerOrderId: order.providerOrderId || null,
    providerStatus: order.providerStatus || null,
    providerError: order.providerError || null
  };
}

async function saveOrder(order) {
  await kvSet(getOrderKey(order.stripeSessionId), order, { ex: SMM_ORDER_TTL_SECONDS });
  if (order.providerOrderId) {
    await kvSet(getProviderOrderKey(order.providerOrderId), order.stripeSessionId, { ex: SMM_ORDER_TTL_SECONDS });
  }
}

async function indexOrder(order) {
  const sessionId = asString(order?.stripeSessionId, 120);
  if (!sessionId) return;

  const current = await kvGet(SMM_ORDER_INDEX_KEY);
  const list = Array.isArray(current) ? current : [];
  const filtered = list.filter((entry) => {
    const existingSessionId = asString(entry?.sessionId || entry, 120);
    return existingSessionId && existingSessionId !== sessionId;
  });

  filtered.unshift({
    sessionId,
    createdAt: asString(order?.createdAt, 80) || toIsoNow()
  });

  await kvSet(SMM_ORDER_INDEX_KEY, filtered.slice(0, SMM_ORDER_INDEX_MAX), { ex: SMM_ORDER_TTL_SECONDS });
}

async function getIndexedOrders(limit = 300) {
  const rawIndex = await kvGet(SMM_ORDER_INDEX_KEY);
  if (!Array.isArray(rawIndex) || !rawIndex.length) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(1000, asInteger(limit) || 300));
  const sessionIds = rawIndex
    .slice(0, safeLimit)
    .map((entry) => asString(entry?.sessionId || entry, 120))
    .filter(Boolean);

  const orders = await Promise.all(sessionIds.map((sessionId) => getOrderBySessionId(sessionId)));
  return orders.filter(Boolean);
}

async function getStripeCompletedOrders(limit = 300) {
  const stripe = getStripeClient();
  const safeLimit = Math.max(1, Math.min(1000, asInteger(limit) || 300));

  const sessions = [];
  let startingAfter = null;

  while (sessions.length < safeLimit) {
    const pageLimit = Math.min(100, safeLimit - sessions.length);
    const page = await stripe.checkout.sessions.list({
      limit: pageLimit,
      status: "complete",
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });

    if (!Array.isArray(page?.data) || !page.data.length) {
      break;
    }

    sessions.push(...page.data);
    if (!page.has_more) {
      break;
    }

    startingAfter = asString(page.data[page.data.length - 1]?.id, 120);
    if (!startingAfter) {
      break;
    }
  }

  const services = await getNormalizedServices();
  const byServiceId = new Map(services.map((service) => [service.serviceId, service]));

  return sessions.map((session) => {
    const serviceId = asInteger(session?.metadata?.service_id);
    const quantity = asInteger(session?.metadata?.quantity);
    const service = serviceId ? byServiceId.get(serviceId) : null;
    const rate = Number.isFinite(service?.rate) ? service.rate : 0;
    const metadataProviderCost = asNumber(session?.metadata?.provider_cost);
    const metadataProviderListCost = asNumber(session?.metadata?.provider_list_cost);
    const hasExactFinance = Number.isFinite(metadataProviderCost) && metadataProviderCost >= 0;

    const estimatedProviderListCost = quantity && quantity > 0
      ? (quantity / 1000) * rate
      : rate;

    const providerListCost = hasExactFinance && Number.isFinite(metadataProviderListCost)
      ? roundMoney(metadataProviderListCost)
      : roundMoney(estimatedProviderListCost);

    const providerCost = hasExactFinance
      ? roundMoney(metadataProviderCost)
      : roundMoney(providerListCost * SMM_PROVIDER_DISCOUNT_FACTOR);

    const retailPrice = roundMoney((asNumber(session?.amount_total) || 0) / 100);
    const createdAt = Number.isFinite(session?.created)
      ? new Date(session.created * 1000).toISOString()
      : toIsoNow();

    return {
      id: `stripe_${asString(session?.id, 120)}`,
      createdAt,
      updatedAt: createdAt,
      status: "completed",
      customerEmail: asString(session?.customer_details?.email, 320) || null,
      serviceId: serviceId || null,
      serviceName: asString(session?.metadata?.service_name, 240) || asString(service?.name, 240) || "Unknown Service",
      serviceType: asString(service?.type, 120) || "",
      category: asString(service?.category, 120) || "",
      quantity: quantity || null,
      link: asString(session?.metadata?.link, 1000) || null,
      retailPrice,
      providerListCost: roundMoney(providerListCost),
      providerCost,
      margin: roundMoney(retailPrice - providerCost),
      currency: asString(session?.currency, 20).toLowerCase() || SMM_CURRENCY,
      stripeSessionId: asString(session?.id, 120),
      stripePaymentIntent: asString(session?.payment_intent, 120) || null,
      providerOrderId: null,
      providerStatus: null,
      providerError: null,
      profitSource: hasExactFinance ? "exact_metadata" : "estimated_rate",
      source: "stripe_sessions"
    };
  });
}

function summarizeProfitOrders(orders) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const windows = {
    last24h: { since: now - dayMs },
    last7d: { since: now - (7 * dayMs) },
    last30d: { since: now - (30 * dayMs) }
  };

  const baseSummary = {
    orderCount: 0,
    paidOrderCount: 0,
    grossRevenue: 0,
    providerCost: 0,
    grossProfit: 0,
    stripeFeeEstimate: 0,
    netProfitEstimate: 0
  };

  const byStatus = {};
  const byService = new Map();

  const scoped = {
    all: { ...baseSummary },
    last24h: { ...baseSummary },
    last7d: { ...baseSummary },
    last30d: { ...baseSummary }
  };

  function addOrder(summaryBucket, order, paidLike) {
    summaryBucket.orderCount += 1;
    if (!paidLike) return;

    const retail = roundMoney(asNumber(order.retailPrice) || 0);
    const provider = roundMoney(asNumber(order.providerCost) || 0);
    const gross = roundMoney(retail - provider);
    const stripeFee = calcStripeFeeEstimate(retail);
    const net = roundMoney(gross - stripeFee);

    summaryBucket.paidOrderCount += 1;
    summaryBucket.grossRevenue = roundMoney(summaryBucket.grossRevenue + retail);
    summaryBucket.providerCost = roundMoney(summaryBucket.providerCost + provider);
    summaryBucket.grossProfit = roundMoney(summaryBucket.grossProfit + gross);
    summaryBucket.stripeFeeEstimate = roundMoney(summaryBucket.stripeFeeEstimate + stripeFee);
    summaryBucket.netProfitEstimate = roundMoney(summaryBucket.netProfitEstimate + net);
  }

  for (const order of orders) {
    const status = asString(order?.status, 80) || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;

    const paidLike = isPaidLikeOrder(order);
    addOrder(scoped.all, order, paidLike);

    const createdAtDate = parseIsoDate(order?.createdAt) || parseIsoDate(order?.updatedAt);
    const createdMs = createdAtDate ? createdAtDate.getTime() : 0;

    if (createdMs >= windows.last24h.since) {
      addOrder(scoped.last24h, order, paidLike);
    }
    if (createdMs >= windows.last7d.since) {
      addOrder(scoped.last7d, order, paidLike);
    }
    if (createdMs >= windows.last30d.since) {
      addOrder(scoped.last30d, order, paidLike);
    }

    if (paidLike) {
      const serviceId = asInteger(order?.serviceId) || 0;
      const key = serviceId ? String(serviceId) : "unknown";
      if (!byService.has(key)) {
        byService.set(key, {
          serviceId,
          serviceName: asString(order?.serviceName, 240) || "Unknown Service",
          orderCount: 0,
          grossRevenue: 0,
          providerCost: 0,
          grossProfit: 0,
          netProfitEstimate: 0
        });
      }

      const row = byService.get(key);
      const retail = roundMoney(asNumber(order.retailPrice) || 0);
      const provider = roundMoney(asNumber(order.providerCost) || 0);
      const gross = roundMoney(retail - provider);
      const net = roundMoney(gross - calcStripeFeeEstimate(retail));

      row.orderCount += 1;
      row.grossRevenue = roundMoney(row.grossRevenue + retail);
      row.providerCost = roundMoney(row.providerCost + provider);
      row.grossProfit = roundMoney(row.grossProfit + gross);
      row.netProfitEstimate = roundMoney(row.netProfitEstimate + net);
    }
  }

  function finalize(summary) {
    const marginPct = summary.grossRevenue > 0
      ? roundMoney((summary.grossProfit / summary.grossRevenue) * 100)
      : 0;

    return {
      ...summary,
      grossMarginPct: marginPct,
      avgNetProfitPerPaidOrder: summary.paidOrderCount > 0
        ? roundMoney(summary.netProfitEstimate / summary.paidOrderCount)
        : 0
    };
  }

  const topServices = [...byService.values()]
    .sort((a, b) => b.netProfitEstimate - a.netProfitEstimate)
    .slice(0, 12);

  return {
    summary: finalize(scoped.all),
    windows: {
      last24h: finalize(scoped.last24h),
      last7d: finalize(scoped.last7d),
      last30d: finalize(scoped.last30d)
    },
    byStatus,
    topServices
  };
}

async function getOrderBySessionId(sessionId) {
  return kvGet(getOrderKey(sessionId));
}

async function handleCheckoutCompleted(session, eventId) {
  const stripeSessionId = asString(session?.id, 120);
  if (!stripeSessionId) return;

  const order = await getOrderBySessionId(stripeSessionId);
  if (!order) {
    return;
  }

  if (order.lastWebhookEventId && order.lastWebhookEventId === eventId) {
    return;
  }

  if (["submitted", "in_progress", "completed", "partial", "canceled"].includes(order.status)) {
    order.lastWebhookEventId = eventId;
    order.updatedAt = toIsoNow();
    await saveOrder(order);
    return;
  }

  order.status = "paid";
  order.lastWebhookEventId = eventId;
  order.updatedAt = toIsoNow();
  order.stripePaymentIntent = asString(session?.payment_intent, 120) || order.stripePaymentIntent || null;

  const email = asString(session?.customer_details?.email, 320);
  if (email) {
    order.customerEmail = email;
  }

  try {
    const providerResponse = await tsmgRequest(order.providerPayload);
    const providerOrderId = asString(providerResponse?.order, 120);

    if (!providerOrderId) {
      throw new Error("TSMG order response did not include an order ID.");
    }

    order.providerOrderId = providerOrderId;
    order.status = "submitted";
    order.providerError = null;
    order.submittedAt = toIsoNow();

    const submittedAlertSent = await sendOrderUpdateAlert(order, "order_submitted");
    if (submittedAlertSent) {
      order.submittedAlertSentAt = toIsoNow();
    }
  } catch (error) {
    order.status = "paid_submission_failed";
    order.providerError = asString(error?.message || "Provider order submit failed", 500);

    const alertSent = await sendSubmissionFailureAlert(order);
    if (alertSent) {
      order.failedSubmissionAlertSentAt = toIsoNow();
    }
  }

  order.updatedAt = toIsoNow();
  await saveOrder(order);
}

export async function handleSmmServices(req, res) {
  if (applyApiGuards(req, res, { rateKey: "smm-services", maxRequests: 40, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const services = await getNormalizedServices();

    const payload = services.map((service) => {
      const sampleQty = service.min && service.min > 0 ? service.min : 100;
      const sampleListCost = (sampleQty / 1000) * service.rate;
      const sampleCost = roundMoney(sampleListCost * SMM_PROVIDER_DISCOUNT_FACTOR);
      const sampleRetailBasis = SMM_RETAIL_PRICE_BASIS === "effective" ? sampleCost : sampleListCost;
      const sampleRetail = roundMoney(sampleRetailBasis * SMM_MARKUP_MULTIPLIER + SMM_FLAT_FEE);
      const typeRule = getTypeRule(service.type || "");

      return {
        serviceId: service.serviceId,
        name: service.name,
        type: service.type,
        category: service.category,
        min: service.min,
        max: service.max,
        requiredFields: typeRule.required,
        sampleQuantity: sampleQty,
        sampleRetail
      };
    });

    return res.json({
      services: payload,
      currency: SMM_CURRENCY,
      pricing: {
        markupMultiplier: SMM_MARKUP_MULTIPLIER,
        flatFee: SMM_FLAT_FEE,
        retailPriceBasis: SMM_RETAIL_PRICE_BASIS
      }
    });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

export async function handleSmmCreateCheckout(req, res) {
  if (applyApiGuards(req, res, { rateKey: "smm-checkout", maxRequests: 10, windowMs: 60_000 })) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = await parseJsonBody(req);
    const serviceId = asInteger(body?.serviceId);

    if (!serviceId) {
      return res.status(400).json({ error: "serviceId is required." });
    }

    const services = await getNormalizedServices();
    const service = services.find((item) => item.serviceId === serviceId);

    if (!service) {
      return res.status(400).json({ error: "Selected service no longer exists." });
    }

    const providerPayload = buildProviderPayload(service, body);
    const pricing = calculatePricing(service, providerPayload);

    if (!Number.isFinite(pricing.retailPrice) || pricing.retailPrice <= 0) {
      return res.status(400).json({ error: "Unable to calculate retail price for this order." });
    }

    const stripe = getStripeClient();
    const baseUrl = getBaseUrl(req);
    const customerEmail = asString(body?.customerEmail, 320);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${baseUrl}/services-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/services-cancel`,
      customer_email: customerEmail || undefined,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: SMM_CURRENCY,
            unit_amount: amountToCents(pricing.retailPrice),
            product_data: {
              name: service.name,
              description: `${service.category} • Service ${service.serviceId}`
            }
          }
        }
      ],
      metadata: {
        service_id: String(service.serviceId),
        service_name: asString(service.name, 120),
        quantity: String(pricing.quantity || ""),
        service_type: asString(service.type, 80),
        link: asString(providerPayload.link || "", 200),
        retail_price: String(roundMoney(pricing.retailPrice)),
        provider_list_cost: String(roundMoney(pricing.providerListCost)),
        provider_cost: String(roundMoney(pricing.providerCost)),
        gross_margin: String(roundMoney(pricing.margin)),
        markup_multiplier: String(roundMoney(SMM_MARKUP_MULTIPLIER)),
        flat_fee: String(roundMoney(SMM_FLAT_FEE)),
        pricing_basis: asString(SMM_RETAIL_PRICE_BASIS, 20),
        provider_discount_pct: String(roundMoney(SMM_PROVIDER_DISCOUNT_PCT)),
        finance_version: "v1"
      }
    });

    const order = {
      id: `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: toIsoNow(),
      updatedAt: toIsoNow(),
      status: "pending_payment",
      customerEmail: customerEmail || null,
      serviceId: service.serviceId,
      serviceName: service.name,
      serviceType: service.type,
      category: service.category,
      quantity: pricing.quantity,
      link: asString(providerPayload.link || "", 1000) || null,
      retailPrice: pricing.retailPrice,
      providerListCost: pricing.providerListCost,
      providerCost: pricing.providerCost,
      margin: pricing.margin,
      providerDiscountPct: pricing.providerDiscountPct,
      providerCouponCode: pricing.providerCouponCode,
      currency: SMM_CURRENCY,
      stripeSessionId: asString(session.id, 120),
      stripePaymentIntent: null,
      providerOrderId: null,
      providerStatus: null,
      providerError: null,
      providerPayload
    };

    await saveOrder(order);
    await indexOrder(order);

    return res.json({
      checkoutUrl: session.url,
      sessionId: session.id,
      order: sanitizeOrder(order)
    });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

export async function handleStripeWebhook(req, res) {
  setCorsHeaders(res, req);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const stripe = getStripeClient();
    const rawBody = await getRawBody(req);
    const signature = asString(req.headers?.["stripe-signature"], 500);
    const webhookSecret = asString(process.env.STRIPE_WEBHOOK_SECRET, 500);

    let event;
    if (webhookSecret) {
      if (!signature) {
        return res.status(400).json({ error: "Missing Stripe-Signature header." });
      }

      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } else {
      event = JSON.parse(rawBody.toString("utf8"));
    }

    if (event?.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data?.object, asString(event.id, 120));
    }

    return res.json({ received: true });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

export async function handleSmmOrderStatus(req, res) {
  if (applyApiGuards(req, res, { rateKey: "smm-status", maxRequests: 20, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const sessionId = asString(req.query?.sessionId, 120);
    const providerOrderId = asString(req.query?.providerOrderId, 120);

    let order = null;

    if (sessionId) {
      order = await getOrderBySessionId(sessionId);
    } else if (providerOrderId) {
      const mappedSessionId = await kvGet(getProviderOrderKey(providerOrderId));
      if (mappedSessionId) {
        order = await getOrderBySessionId(asString(mappedSessionId, 120));
      }
    } else {
      return res.status(400).json({ error: "sessionId or providerOrderId is required." });
    }

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const shouldRefresh = asString(req.query?.refresh, 10) === "1";
    if (shouldRefresh && order.providerOrderId) {
      try {
        const providerStatus = await tsmgRequest({ action: "status", order: order.providerOrderId });
        order.providerStatus = asString(providerStatus?.status, 100) || null;
        order.status = statusFromProvider(order.providerStatus, order.status);
        order.updatedAt = toIsoNow();
        await saveOrder(order);
      } catch (error) {
        order.providerError = asString(error?.message || "Failed to refresh provider status", 400);
        order.updatedAt = toIsoNow();
        await saveOrder(order);
      }
    }

    return res.json({ order: sanitizeOrder(order) });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

export async function handleSmmProfitDashboard(req, res) {
  if (applyApiGuards(req, res, { rateKey: "smm-profit-dashboard", maxRequests: 30, windowMs: 60_000 })) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = ensureDashboardAccess(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  try {
    const limit = Math.max(25, Math.min(1000, asInteger(req.query?.limit) || 300));
    const includeRecent = asString(req.query?.includeRecent, 10) !== "0";
    const includeStripe = asString(req.query?.includeStripe, 10) !== "0";

    const indexedOrders = await getIndexedOrders(limit);
    let stripeOrders = [];

    if (includeStripe) {
      try {
        stripeOrders = await getStripeCompletedOrders(limit);
      } catch (error) {
        console.warn("Failed to load Stripe sessions for dashboard:", error?.message || error);
      }
    }

    const mergedBySession = new Map();
    for (const order of stripeOrders) {
      const key = asString(order?.stripeSessionId || order?.id, 140);
      if (!key) continue;
      mergedBySession.set(key, order);
    }

    for (const order of indexedOrders) {
      const key = asString(order?.stripeSessionId || order?.id, 140);
      if (!key) continue;
      mergedBySession.set(key, order);
    }

    const mergedOrders = [...mergedBySession.values()]
      .sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0))
      .slice(0, limit);

    const exactProfitOrders = mergedOrders.filter((order) => asString(order?.profitSource, 40) === "exact_metadata").length;
    const estimatedProfitOrders = mergedOrders.length - exactProfitOrders;
    const exactProfitCoveragePct = mergedOrders.length
      ? roundMoney((exactProfitOrders / mergedOrders.length) * 100)
      : 0;

    const profit = summarizeProfitOrders(mergedOrders);

    let dataSource = "order_index";
    if (indexedOrders.length && stripeOrders.length) {
      dataSource = "hybrid";
    } else if (!indexedOrders.length && stripeOrders.length) {
      dataSource = "stripe_sessions";
    }

    const recentOrders = includeRecent
      ? mergedOrders
          .slice()
          .sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0))
          .slice(0, 50)
          .map((order) => ({
            id: order.id,
            createdAt: order.createdAt,
            status: order.status,
            serviceId: order.serviceId,
            serviceName: order.serviceName,
            retailPrice: roundMoney(asNumber(order.retailPrice) || 0),
            providerCost: roundMoney(asNumber(order.providerCost) || 0),
            grossProfit: roundMoney((asNumber(order.retailPrice) || 0) - (asNumber(order.providerCost) || 0)),
            netProfitEstimate: roundMoney(((asNumber(order.retailPrice) || 0) - (asNumber(order.providerCost) || 0)) - calcStripeFeeEstimate(asNumber(order.retailPrice) || 0)),
            currency: order.currency || SMM_CURRENCY
          }))
      : [];

    return res.json({
      generatedAt: toIsoNow(),
      pricingConfig: {
        markupMultiplier: SMM_MARKUP_MULTIPLIER,
        flatFee: SMM_FLAT_FEE,
        retailPriceBasis: SMM_RETAIL_PRICE_BASIS,
        providerDiscountPct: SMM_PROVIDER_DISCOUNT_PCT,
        providerCouponCode: SMM_PROVIDER_COUPON_CODE
      },
      dataSource,
      indexedOrderCount: indexedOrders.length,
      stripeOrderCount: stripeOrders.length,
      mergedOrderCount: mergedOrders.length,
      exactProfitOrders,
      estimatedProfitOrders,
      exactProfitCoveragePct,
      ...profit,
      recentOrders
    });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

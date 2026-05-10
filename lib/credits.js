import Stripe from "stripe";
import { getCache, setCache } from "../utils.js";

const FREE_TRIAL_COOKIE_NAME = "pf_free_search_used_v1";
const CREDIT_SESSION_CACHE_TTL_MS = 60 * 1000;

const CREDIT_PLANS = [
  {
    id: "starter",
    name: "Starter",
    credits: 15,
    priceCents: 1900,
    description: "Best for solo creators or quick one-off research bursts.",
    highlight: "Roughly 3-7 paid searches depending on tool mix."
  },
  {
    id: "pro",
    name: "Pro",
    credits: 60,
    priceCents: 5900,
    description: "Built for regular sponsor research, outreach, and brand prospecting.",
    highlight: "Best value for active weekly use."
  },
  {
    id: "agency",
    name: "Agency",
    credits: 180,
    priceCents: 14900,
    description: "For agencies, researchers, and heavy multi-channel workflows.",
    highlight: "Lowest effective cost per scan."
  }
];

const TOOL_CREDIT_COSTS = {
  analyze: 2,
  collab: 2,
  domain: 3,
  compare: 4,
  unlisted: 5
};

let stripeClient = null;

function asString(value, maxLen = 500) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLen);
}

function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUsdFromCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
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

function parseCookieMap(req) {
  const raw = asString(req?.headers?.cookie, 4000);
  if (!raw) return {};

  const pairs = raw.split(";");
  const cookieMap = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookieMap[key] = value;
  }
  return cookieMap;
}

function hasFreeTrialCookie(req) {
  const cookies = parseCookieMap(req);
  return cookies[FREE_TRIAL_COOKIE_NAME] === "1";
}

function appendSetCookie(res, value) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, value]);
    return;
  }
  res.setHeader("Set-Cookie", [current, value]);
}

function shouldUseSecureCookies(req) {
  const forwardedProto = asString(req?.headers?.['x-forwarded-proto'], 20).toLowerCase();
  if (forwardedProto === 'https') return true;

  const origin = asString(req?.headers?.origin, 200).toLowerCase();
  if (origin.startsWith('https://')) return true;

  const host = asString(req?.headers?.host, 200).toLowerCase();
  if (!host) return true;
  if (host.includes('localhost') || host.startsWith('127.0.0.1')) return false;
  return true;
}

function setFreeTrialCookie(req, res) {
  const secureFlag = shouldUseSecureCookies(req) ? '; Secure' : '';
  appendSetCookie(
    res,
    `${FREE_TRIAL_COOKIE_NAME}=1; Max-Age=31536000; Path=/; SameSite=Lax${secureFlag}`
  );
}

function normalizeTokens(rawValue) {
  return Array.from(
    new Set(
      String(rawValue || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => /^cs_[A-Za-z0-9_]+$/.test(value))
    )
  ).slice(0, 8);
}

function parseCreditTokens(req) {
  const queryTokens = normalizeTokens(req?.query?.creditToken || req?.query?.token || "");
  if (queryTokens.length) return queryTokens;

  const headerTokens = normalizeTokens(req?.headers?.["x-credit-token"] || "");
  if (headerTokens.length) return headerTokens;

  return [];
}

function getSessionCacheKey(sessionId) {
  return `credit_session::${sessionId}`;
}

async function getCreditSession(sessionId, forceRefresh = false) {
  const cacheKey = getSessionCacheKey(sessionId);
  if (!forceRefresh) {
    const cached = getCache(cacheKey);
    if (cached) return cached;
  }

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    setCache(cacheKey, session, CREDIT_SESSION_CACHE_TTL_MS);
    return session;
  } catch {
    return null;
  }
}

function isPaidCreditSession(session) {
  if (!session || typeof session !== "object") return false;
  if (session.payment_status !== "paid") return false;
  return asString(session.metadata?.purchase_type, 80) === "credits";
}

function getPlanById(planId) {
  return CREDIT_PLANS.find((plan) => plan.id === planId) || null;
}

function getPublicPlans() {
  return CREDIT_PLANS.map((plan) => ({
    ...plan,
    priceLabel: formatUsdFromCents(plan.priceCents)
  }));
}

function getToolCosts() {
  return { ...TOOL_CREDIT_COSTS };
}

function getToolCreditCost(toolKey) {
  return TOOL_CREDIT_COSTS[toolKey] || 1;
}

function getRemainingCredits(session) {
  return Math.max(0, asInteger(session?.metadata?.credits_remaining, 0));
}

function getTotalCredits(session) {
  return Math.max(0, asInteger(session?.metadata?.credits_total, 0));
}

function toBalanceSummary(session) {
  const planId = asString(session?.metadata?.plan_id, 80);
  const plan = getPlanById(planId);
  return {
    token: session.id,
    planId,
    planName: plan?.name || asString(session?.metadata?.plan_name, 120) || "Credits Pack",
    creditsTotal: getTotalCredits(session),
    creditsRemaining: getRemainingCredits(session),
    priceLabel: plan ? formatUsdFromCents(plan.priceCents) : null,
    paidAt: session?.created ? new Date(session.created * 1000).toISOString() : null,
    status: session?.payment_status || "unpaid"
  };
}

async function resolveEligibleSessions(tokens, requiredCredits) {
  const sessions = [];
  for (const token of tokens) {
    const session = await getCreditSession(token);
    if (!isPaidCreditSession(session)) continue;
    sessions.push(session);
  }

  const balances = sessions.map(toBalanceSummary);
  const eligible = sessions.find((session) => getRemainingCredits(session) >= requiredCredits) || null;
  return { eligible, balances };
}

export async function getToolAccessState(req, toolKey) {
  const requiredCredits = getToolCreditCost(toolKey);
  const tokens = parseCreditTokens(req);

  if (tokens.length) {
    const { eligible, balances } = await resolveEligibleSessions(tokens, requiredCredits);
    if (eligible) {
      return {
        allowed: true,
        mode: "paid",
        toolKey,
        requiredCredits,
        token: eligible.id,
        session: eligible,
        balances
      };
    }

    return {
      allowed: false,
      mode: "blocked",
      toolKey,
      requiredCredits,
      balances,
      reason: balances.length ? "insufficient_credits" : "invalid_token"
    };
  }

  if (!hasFreeTrialCookie(req)) {
    return {
      allowed: true,
      mode: "free",
      toolKey,
      requiredCredits
    };
  }

  return {
    allowed: false,
    mode: "blocked",
    toolKey,
    requiredCredits,
    balances: [],
    reason: "free_trial_used"
  };
}

export function buildPaymentRequiredResponse(state) {
  const toolCost = state?.requiredCredits || 1;
  const toolName = asString(state?.toolKey, 80) || "tool";
  const reason = state?.reason || "free_trial_used";

  let error = `This ${toolName} scan requires ${toolCost} credit${toolCost === 1 ? "" : "s"}.`;
  if (reason === "free_trial_used") {
    error = `Your free preview has already been used. This ${toolName} scan requires ${toolCost} credit${toolCost === 1 ? "" : "s"}.`;
  } else if (reason === "insufficient_credits") {
    error = `Your saved credit packs do not have enough remaining balance for this ${toolName} scan.`;
  } else if (reason === "invalid_token") {
    error = `Your saved credit token is no longer valid. Buy a new pack to continue.`;
  }

  return {
    error,
    code: "PAYMENT_REQUIRED",
    creditsUrl: "/credits",
    tool: toolName,
    toolCost,
    plans: getPublicPlans(),
    balances: Array.isArray(state?.balances) ? state.balances : []
  };
}

export async function finalizeToolAccess(req, res, state, options = {}) {
  const chargeCredits = options.chargeCredits !== false;

  if (!state?.allowed) {
    return { ok: false, payload: buildPaymentRequiredResponse(state) };
  }

  if (state.mode === "free") {
    setFreeTrialCookie(req, res);
    return {
      ok: true,
      access: {
        mode: "free",
        chargedCredits: 0,
        freeTrialUsed: true
      }
    };
  }

  if (!chargeCredits) {
    return {
      ok: true,
      access: {
        mode: "paid",
        chargedCredits: 0,
        token: state.token,
        creditsRemaining: getRemainingCredits(state.session),
        creditsTotal: getTotalCredits(state.session)
      }
    };
  }

  const latestSession = await getCreditSession(state.token, true);
  if (!isPaidCreditSession(latestSession) || getRemainingCredits(latestSession) < state.requiredCredits) {
    return {
      ok: false,
      payload: buildPaymentRequiredResponse({
        ...state,
        balances: latestSession && isPaidCreditSession(latestSession)
          ? [toBalanceSummary(latestSession)]
          : state.balances,
        reason: "insufficient_credits"
      })
    };
  }

  const remainingAfter = getRemainingCredits(latestSession) - state.requiredCredits;
  const stripe = getStripeClient();
  await stripe.checkout.sessions.update(state.token, {
    metadata: {
      credits_remaining: String(remainingAfter),
      last_credit_use_at: new Date().toISOString(),
      last_credit_use_tool: asString(state.toolKey, 80)
    }
  });

  const updatedSession = {
    ...latestSession,
    metadata: {
      ...(latestSession.metadata || {}),
      credits_remaining: String(remainingAfter),
      last_credit_use_at: new Date().toISOString(),
      last_credit_use_tool: asString(state.toolKey, 80)
    }
  };
  setCache(getSessionCacheKey(state.token), updatedSession, CREDIT_SESSION_CACHE_TTL_MS);

  return {
    ok: true,
    access: {
      mode: "paid",
      chargedCredits: state.requiredCredits,
      token: state.token,
      creditsRemaining: remainingAfter,
      creditsTotal: getTotalCredits(updatedSession)
    }
  };
}

export async function createCreditsCheckoutSession(planId, req) {
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error("Invalid credit plan.");
  }

  const stripe = getStripeClient();
  const baseUrl = getBaseUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    billing_address_collection: "auto",
    customer_creation: "always",
    allow_promotion_codes: true,
    success_url: `${baseUrl}/credits?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/credits?canceled=1`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: plan.priceCents,
          product_data: {
            name: `PromoFinder ${plan.name} Credits`,
            description: `${plan.credits} credits for sponsor, domain, collaboration, comparison, and unlisted research tools.`
          }
        }
      }
    ],
    metadata: {
      purchase_type: "credits",
      plan_id: plan.id,
      plan_name: plan.name,
      credits_total: String(plan.credits),
      credits_remaining: String(plan.credits)
    }
  });

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
    plan: {
      id: plan.id,
      name: plan.name,
      credits: plan.credits,
      priceLabel: formatUsdFromCents(plan.priceCents)
    }
  };
}

export async function claimCreditsSession(sessionId) {
  const safeSessionId = asString(sessionId, 200);
  if (!/^cs_[A-Za-z0-9_]+$/.test(safeSessionId)) {
    throw new Error("Invalid Stripe session id.");
  }

  const session = await getCreditSession(safeSessionId, true);
  if (!session) {
    throw new Error("Credit session not found.");
  }
  if (!isPaidCreditSession(session)) {
    throw new Error("Checkout is not paid yet. Complete payment first.");
  }

  return {
    token: session.id,
    balance: toBalanceSummary(session),
    plans: getPublicPlans(),
    toolCosts: getToolCosts()
  };
}

export async function getBalancesForTokens(tokens) {
  const normalizedTokens = Array.isArray(tokens) ? tokens : normalizeTokens(tokens);
  const sessions = await Promise.all(normalizedTokens.map((token) => getCreditSession(token)));
  const balances = sessions.filter((session) => isPaidCreditSession(session)).map(toBalanceSummary);
  return {
    balances,
    totalRemaining: balances.reduce((sum, balance) => sum + (balance.creditsRemaining || 0), 0),
    toolCosts: getToolCosts(),
    plans: getPublicPlans()
  };
}

export function getCreditsCatalog() {
  return {
    plans: getPublicPlans(),
    toolCosts: getToolCosts(),
    freeTrial: {
      searchesIncluded: 1,
      note: "Each browser gets one free research search before credits are required."
    }
  };
}
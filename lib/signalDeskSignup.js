import { applyApiGuards, handleApiError, setCorsHeaders } from "../utils.js";

const DESTINATION_EMAIL = process.env.SIGNAL_DESK_SIGNUP_EMAIL || "david@4ourmedia.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getRelayUrl() {
  if (process.env.SIGNAL_DESK_SIGNUP_RELAY_URL) {
    return process.env.SIGNAL_DESK_SIGNUP_RELAY_URL;
  }
  return `https://formsubmit.co/ajax/${encodeURIComponent(DESTINATION_EMAIL)}`;
}

function asString(value, maxLength = 320) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseRequestBody(req) {
  if (req?.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req?.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function buildSignupPayload(body) {
  return {
    name: asString(body?.name, 120),
    email: asString(body?.email, 320).toLowerCase(),
    markets: asString(body?.markets, 160),
    timeframe: asString(body?.timeframe, 120),
    experience: asString(body?.experience, 80),
    goals: asString(body?.goals, 2000),
    website: asString(body?.website, 320)
  };
}

function validateSignupPayload(signup) {
  if (!signup.name || signup.name.length < 2) {
    return "Enter your name.";
  }
  if (!signup.email || !EMAIL_PATTERN.test(signup.email)) {
    return "Enter a valid email address.";
  }
  if (!signup.markets || signup.markets.length < 2) {
    return "Tell us what you trade.";
  }
  if (!signup.timeframe || signup.timeframe.length < 2) {
    return "Tell us your time horizon.";
  }
  if (!signup.experience) {
    return "Choose your experience level.";
  }
  if (!signup.goals || signup.goals.length < 12) {
    return "Tell us what you want the desk to solve first.";
  }
  return null;
}

async function relaySignup(signup, req) {
  const relayPayload = {
    _subject: `Signal Desk founder beta signup: ${signup.name}`,
    _template: "table",
    _captcha: "false",
    _replyto: signup.email,
    name: signup.name,
    email: signup.email,
    markets: signup.markets,
    timeframe: signup.timeframe,
    experience: signup.experience,
    goals: signup.goals,
    source: "ANAMNESIS Signal Desk",
    submitted_at: new Date().toISOString(),
    submitted_from: asString(req?.headers?.origin || req?.headers?.referer || "https://promofinder.4ourmedia.com/signal-desk", 500),
    user_agent: asString(req?.headers?.["user-agent"], 500)
  };

  const response = await fetch(getRelayUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(relayPayload)
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw ? { message: raw } : null;
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || "Unable to submit signup right now.");
    error.status = response.status;
    throw error;
  }

  return data;
}

export async function handleSignalDeskSignup(req, res) {
  setCorsHeaders(res, req);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Request-ID");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (applyApiGuards(req, res, { rateKey: "signal-desk-signup", maxRequests: 10, windowMs: 10 * 60_000, skipMethods: [] })) return;
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed.", requestId: req.requestId || res.getHeader("X-Request-ID") });
  }

  try {
    const signup = buildSignupPayload(parseRequestBody(req));

    if (signup.website) {
      return res.status(200).json({ ok: true, message: "Thanks — your request has been received.", requestId: req.requestId || res.getHeader("X-Request-ID") });
    }

    const validationError = validateSignupPayload(signup);
    if (validationError) {
      return res.status(400).json({ error: validationError, requestId: req.requestId || res.getHeader("X-Request-ID") });
    }

    await relaySignup(signup, req);

    return res.status(200).json({
      ok: true,
      message: "Thanks — your founder beta request is in. We will follow up by email.",
      requestId: req.requestId || res.getHeader("X-Request-ID")
    });
  } catch (error) {
    if (error?.status) {
      return res.status(502).json({
        error: "The signup request could not be delivered right now. Please try again in a few minutes.",
        requestId: req.requestId || res.getHeader("X-Request-ID")
      });
    }
    return handleApiError(res, error, req);
  }
}
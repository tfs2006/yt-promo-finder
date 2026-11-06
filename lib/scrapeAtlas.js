/**
 * Shared Scrape Atlas client for PromoFinder (server-side only).
 *
 * Scrape Atlas: https://api.scrapeatlas.com, auth via the x-api-key header,
 * 1 credit per successful request, 0 credits for failed requests.
 * The key lives in the SCRAPE_ATLAS_API_KEY Vercel env var and is never
 * logged, never returned to the browser, and never embedded in error text.
 *
 * Rules enforced here:
 * - A pasted literal trailing "\r" / "\n" is stripped from the env value
 *   (same defect broke the Supabase key Nov 2 2026 and was the prime
 *   suspect in the Stripe webhook failure Nov 5 2026).
 * - A 429 (upstream_rate_limited) is never retried blindly: the call fails
 *   soft with a clear message and the caller must not charge the user.
 * - Every call is counted in a server-side KV ledger (total + daily) so a
 *   runaway loop or abuse spike cannot silently drain the 50,000-credit
 *   grant. The ledger is fire-and-forget and never blocks a response.
 * - Responses are returned trimmed by the caller: never forward raw SA JSON
 *   to the browser (Vercel response cap ~4.5 MB).
 */
import { kvIncr } from "../utils.js";

const SA_BASE = "https://api.scrapeatlas.com";

function stripEnvKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/(\\[rn])+$/, "");
}

export function getScrapeAtlasKey() {
  return stripEnvKey(process.env.SCRAPE_ATLAS_API_KEY);
}

export function isScrapeAtlasConfigured() {
  return getScrapeAtlasKey().length > 0;
}

export class ScrapeAtlasError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "ScrapeAtlasError";
    this.code = code;
    this.status = status;
  }
}

function errorFromStatus(status, body) {
  const failureCode = body?.failure?.code || "";
  const failureMessage = body?.failure?.message || "";
  if (status === 401) {
    return new ScrapeAtlasError(
      "SA_UNAUTHORIZED",
      "Scrape Atlas rejected the API key. The site owner has been notified.",
      502
    );
  }
  if (status === 404) {
    return new ScrapeAtlasError(
      "SA_NOT_FOUND",
      "Scrape Atlas found nothing for that input.",
      404
    );
  }
  if (status === 429 || failureCode === "upstream_rate_limited") {
    return new ScrapeAtlasError(
      "SA_RATE_LIMITED",
      "The data source is rate limited right now. Please try again in a minute. No credits were charged.",
      429
    );
  }
  if (status === 503 || failureCode === "busy") {
    return new ScrapeAtlasError(
      "SA_BUSY",
      "Scrape Atlas is busy right now. Please try again shortly. No credits were charged.",
      503
    );
  }
  if (status === 504 || failureCode === "timeout") {
    return new ScrapeAtlasError(
      "SA_TIMEOUT",
      "The data source took too long to answer. Please try again. No credits were charged.",
      504
    );
  }
  const detail = failureMessage ? ` (${failureMessage})` : "";
  return new ScrapeAtlasError(
    "SA_UPSTREAM_ERROR",
    `Scrape Atlas could not complete that request${detail}. No credits were charged.`,
    502
  );
}

/**
 * Count one SA call in the server-side ledger. Fire-and-forget: a ledger
 * failure must never fail the user's request.
 */
export function logSaCall(tool, endpoint, success) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const calls = [
      kvIncr("sa_ledger:total"),
      kvIncr(`sa_ledger:day:${day}`),
      kvIncr(`sa_ledger:tool:${tool || "unknown"}`),
      kvIncr(`sa_ledger:endpoint:${(endpoint || "unknown").replace(/[^a-z0-9/_-]/gi, "_")}`)
    ];
    if (!success) calls.push(kvIncr("sa_ledger:failed"));
    Promise.all(calls).catch(() => {});
  } catch {
    // Ledger is best-effort only.
  }
}

/**
 * Call a Scrape Atlas GET endpoint and return the parsed JSON body.
 * Throws ScrapeAtlasError on any failure (including success:false bodies).
 * options: { tool (ledger label), timeoutMs (default 8000), params (object) }
 * The returned body always carries { status, coverage, fetchedAt } when SA
 * provides them; callers surface coverage.complete === false to the user
 * instead of presenting partial data as complete.
 */
export async function saGet(path, options = {}) {
  const tool = options.tool || "unknown";
  const timeoutMs = options.timeoutMs || 8000;
  const key = getScrapeAtlasKey();
  if (!key) {
    throw new ScrapeAtlasError(
      "SA_NOT_CONFIGURED",
      "Scrape Atlas is not configured on this site yet.",
      502
    );
  }

  const url = new URL(path.startsWith("http") ? path : `${SA_BASE}${path}`);
  for (const [name, value] of Object.entries(options.params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    logSaCall(tool, path, false);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ScrapeAtlasError(
        "SA_TIMEOUT",
        "The data source took too long to answer. Please try again. No credits were charged.",
        504
      );
    }
    throw new ScrapeAtlasError(
      "SA_UPSTREAM_ERROR",
      "Could not reach Scrape Atlas. Please try again. No credits were charged.",
      502
    );
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.success === false) {
    logSaCall(tool, path, false);
    throw errorFromStatus(response.status, body);
  }

  logSaCall(tool, path, true);
  return body;
}

/** Trim a value to a short plain string for UI responses. */
export function saText(value, maxLen = 600) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, maxLen);
}

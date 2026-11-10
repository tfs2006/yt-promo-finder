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

/** Null-safe integer: SA counts are null when the About panel or the
 *  video extras could not be read. Callers treat a missing count as 0
 *  and disclose the gap through coverage warnings, never as a real 0
 *  the user would mistake for measured data. */
export function saNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Map a parseChannelIdFromUrl() spec onto youtube/channel query params.
 * channelId / handle / forUsername map one-to-one; /user/ and /c/ forms
 * and full channel URLs go through the url param, which the endpoint
 * documents as accepting /channel/UC..., /user/name, /c/name and legacy
 * youtube.com/name links. A bare non-URL value is tried as a handle.
 */
export function saChannelParams(spec, input) {
  if (!spec) return { url: input };
  if (spec.type === "channelId") return { channelId: spec.value };
  if (spec.type === "handle") {
    return { handle: spec.value.startsWith("@") ? spec.value : `@${spec.value}` };
  }
  if (spec.type === "username") return { forUsername: spec.value };
  if (spec.type === "custom") return { url: `https://www.youtube.com/c/${spec.value}` };
  if (/^https?:\/\//i.test(String(input || "").trim())) return { url: String(input).trim() };
  return { handle: `@${String(spec.value || "").replace(/^@/, "")}` };
}

/**
 * Fetch one channel record from Scrape Atlas and return the raw body.
 * This single call serves as both the handle resolve and the channel
 * stats fetch, so handlers must not also call resolveChannelId() (which
 * would spend a second SA call resolving the same channel). Throws a
 * plain Error("Channel not found.") when SA returns no channelId.
 */
export async function fetchSaChannel(spec, input, tool) {
  const body = await saGet("/v1/youtube/channel", {
    tool,
    timeoutMs: 8000,
    params: saChannelParams(spec, input)
  });
  if (!body || typeof body.channelId !== "string" || !body.channelId) {
    throw new Error("Channel not found.");
  }
  return body;
}

/**
 * Parse a youtube/channel joinedDateText ("Joined Jul 30, 2019") into an
 * ISO date string. Returns null when the text is missing or unparseable
 * (About panel unavailable); callers keep the field null rather than
 * inventing a date.
 */
export function parseSaJoinedDate(joinedDateText) {
  if (!joinedDateText) return null;
  const cleaned = String(joinedDateText).replace(/^Joined\s+/i, "").trim();
  const ms = Date.parse(cleaned);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Largest avatar source URL from a youtube/channel body, or "". */
export function saChannelAvatarUrl(channel) {
  const sources = channel?.avatar?.image?.sources;
  if (!Array.isArray(sources) || !sources.length) return "";
  let best = sources[0];
  for (const s of sources) {
    if (Number(s?.width || 0) > Number(best?.width || 0)) best = s;
  }
  return best?.url || "";
}

/**
 * Normalize one youtube/channel-videos item onto the fields the handlers
 * compute from. Without includeExtras, description/likeCount/commentCount
 * are null in the SA body and come back as "" / 0 here; publishDate is
 * the exact ISO date (extras only), publishedTime the computed one.
 * durationSeconds prefers the exact extras durationMs and falls back to
 * the list-page lengthSeconds (durationMs is null without extras).
 */
export function mapSaChannelVideo(video) {
  const durationMs = saNumber(video?.durationMs);
  return {
    videoId: video?.id || "",
    title: video?.title || "",
    description: video?.description ?? "",
    publishedAt: video?.publishDate || video?.publishedTime || "",
    viewCount: saNumber(video?.viewCountInt),
    likeCount: saNumber(video?.likeCountInt),
    commentCount: saNumber(video?.commentCountInt),
    durationSeconds: durationMs > 0 ? Math.round(durationMs / 1000) : saNumber(video?.lengthSeconds)
  };
}

/** Collect SA coverage warnings into a deduped list. */
export function collectSaWarnings(body, warnings) {
  if (Array.isArray(body?.coverage?.warnings)) {
    for (const warning of body.coverage.warnings) {
      if (warning && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  return warnings;
}

const SA_VIDEO_MAX_PAGES = 4;
const SA_VIDEO_MAX_VIDEOS = 200;
const SA_VIDEO_DEADLINE_MS = 55000;
const SA_VIDEO_PAGE_TIMEOUT_MS = 40000;
const SA_VIDEO_MIN_REMAINING_MS = 18000;

/**
 * Fetch a channel's latest videos with extras for the viral and
 * predictor tools: one channel record (handle resolve + stats) plus
 * newest-first channel-videos pages with includeExtras=true, windowed
 * to the last 12 months via `since`.
 *
 * Why this shape: an extras page takes about 15s upstream (two reads
 * per video), so sequential continuation paging is the only honest
 * order, and callers run with maxDuration 60 and this 55s deadline
 * guard (same pattern as api/rate.js). The channel record and the
 * first video page are independent, so they are fetched in parallel;
 * the exception is a legacy /user/ input, whose forUsername param the
 * channel-videos endpoint does not accept, so that input resolves the
 * channel first and then pages by channelId. Date windows do NOT shard
 * this endpoint (verified live Nov 10 2026: a windowed call still
 * starts at the newest video and filters while paging), so parallel
 * windows would each re-walk the same videos. sort=popular is not
 * used either: it falls back to latest with a sort_unavailable warning
 * on channels whose videos tab has no sort chip (verified live the
 * same day), so it would only duplicate the latest page.
 *
 * Returns { channel, channelId, videos, pagesFetched, coverageWarnings,
 * fetchedAt, withDescription, withStats, withViews, withDuration,
 * deadlineHit, hasMore, saCreditsUsed }. videos are mapSaChannelVideo
 * rows. hasMore is true when more in-window videos exist past what was
 * collected (video cap, page cap or deadline); callers disclose it
 * instead of presenting partial data as complete. A page that returns
 * zero videos ends the walk: with only a `since` bound, an empty
 * newest-first page means every video predates the window.
 */
export async function fetchSaLatestVideosForChannel(options) {
  const {
    tool,
    spec,
    input,
    sinceISO,
    maxVideos = SA_VIDEO_MAX_VIDEOS,
    maxPages = SA_VIDEO_MAX_PAGES,
    startedAt = Date.now(),
    deadlineMs = SA_VIDEO_DEADLINE_MS,
    pageTimeoutMs = SA_VIDEO_PAGE_TIMEOUT_MS,
    minRemainingForNextPageMs = SA_VIDEO_MIN_REMAINING_MS
  } = options;

  const sinceMs = sinceISO ? Date.parse(sinceISO) : NaN;
  const pageParams = { sort: "latest", since: sinceISO, includeExtras: true };
  const firstParams = saChannelParams(spec, input);

  let channel;
  let firstPage;
  if (firstParams.channelId || firstParams.handle || firstParams.url) {
    [channel, firstPage] = await Promise.all([
      fetchSaChannel(spec, input, tool),
      saGet("/v1/youtube/channel-videos", {
        tool,
        timeoutMs: pageTimeoutMs,
        params: { ...firstParams, ...pageParams }
      })
    ]);
  } else {
    // Legacy /user/ input: channel-videos takes no forUsername param.
    channel = await fetchSaChannel(spec, input, tool);
    firstPage = await saGet("/v1/youtube/channel-videos", {
      tool,
      timeoutMs: pageTimeoutMs,
      params: { channelId: channel.channelId, ...pageParams }
    });
  }
  const channelId = channel.channelId;

  const videos = [];
  const coverageWarnings = [];
  let fetchedAt = channel.fetchedAt || "";
  let withDescription = 0;
  let withStats = 0;
  let withViews = 0;
  let withDuration = 0;
  let pagesFetched = 0;
  let deadlineHit = false;
  let stopReason = "done";

  let page = firstPage;
  while (page) {
    pagesFetched++;
    if (page?.fetchedAt) fetchedAt = page.fetchedAt;
    collectSaWarnings(page, coverageWarnings);

    const items = Array.isArray(page?.videos) ? page.videos : [];
    if (items.length === 0) {
      stopReason = "past-window";
      break;
    }
    for (const item of items) {
      if (item?.type && item.type !== "video") continue;
      if (item?.description !== null && item?.description !== undefined) withDescription++;
      if (item?.likeCountInt !== null && item?.likeCountInt !== undefined) withStats++;
      if (item?.viewCountInt !== null && item?.viewCountInt !== undefined) withViews++;
      if (item?.durationMs !== null && item?.durationMs !== undefined) withDuration++;
      const mapped = mapSaChannelVideo(item);
      // Extras give the exact publish date; drop anything outside the
      // window (window edges are approximate without extras).
      const publishedMs = mapped.publishedAt ? Date.parse(mapped.publishedAt) : NaN;
      if (Number.isFinite(sinceMs) && Number.isFinite(publishedMs) && publishedMs < sinceMs) continue;
      videos.push(mapped);
      if (videos.length >= maxVideos) break;
    }

    const continuationToken = page?.continuationToken || undefined;
    if (videos.length >= maxVideos) {
      stopReason = "max-videos";
      break;
    }
    if (!continuationToken) {
      stopReason = "done";
      break;
    }
    const dated = items.map((item) => item?.publishDate).filter(Boolean);
    if (
      Number.isFinite(sinceMs) && dated.length > 0 &&
      dated.every((d) => Number.isFinite(Date.parse(d)) && Date.parse(d) < sinceMs)
    ) {
      stopReason = "past-window";
      break;
    }
    if (pagesFetched >= maxPages) {
      stopReason = "max-pages";
      break;
    }
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs < minRemainingForNextPageMs) {
      deadlineHit = true;
      stopReason = "deadline";
      break;
    }
    page = await saGet("/v1/youtube/channel-videos", {
      tool,
      timeoutMs: Math.min(pageTimeoutMs, Math.max(remainingMs, 1000)),
      params: { channelId, ...pageParams, continuationToken }
    });
  }

  return {
    channel,
    channelId,
    videos,
    pagesFetched,
    coverageWarnings,
    fetchedAt,
    withDescription,
    withStats,
    withViews,
    withDuration,
    deadlineHit,
    hasMore: stopReason === "max-videos" || stopReason === "max-pages" || stopReason === "deadline",
    saCreditsUsed: 1 + pagesFetched
  };
}

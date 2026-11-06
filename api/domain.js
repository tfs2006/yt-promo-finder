import {
  setCache,
  getCache,
  applyApiGuards,
  handleApiError,
  validateDomainInput
} from "../utils.js";
import {
  buildPaymentRequiredResponse,
  finalizeToolAccess,
  getToolAccessState
} from "../lib/credits.js";
import { isScrapeAtlasConfigured, saGet } from "../lib/scrapeAtlas.js";

// Domain search on Scrape Atlas (replaces the YouTube Data API version,
// which burned 500+ quota units per run). Cost: 1 SA credit per search
// page fetched, max 3 pages per run. No YouTube quota is consumed.
// The UI contract is unchanged: { domain, videoCount, totalFound,
// videos: [{ videoId, title, channelTitle, channelId, publishedAt,
// thumbnail, viewCount }] }. Extra fields (fetchedAt,
// descriptionCoverage, coverageNote, coverageWarnings, saCreditsUsed)
// are additive only.

const MAX_PAGES = 3;
const PER_CALL_TIMEOUT_MS = 8000;
// Vercel Hobby functions time out at 10s; stop paging with time to spare
// and return what was found so far instead of failing the request.
const GLOBAL_DEADLINE_MS = 9000;
const MAX_MATCHES = 100;
const MAX_RESULTS = 50;

export default async function handler(req, res) {
  if (applyApiGuards(req, res, { rateKey: "domain", maxRequests: 8, windowMs: 60_000 })) return;

  const startedAt = Date.now();

  try {
    const rawInput = (req.query.domain || "").toString();
    const validation = validateDomainInput(rawInput);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || "Invalid domain." });
    }
    const domain = validation.sanitized;

    if (!isScrapeAtlasConfigured()) {
      return res.status(500).json({ error: "Scrape Atlas is not configured on this site yet." });
    }

    const accessState = await getToolAccessState(req, 'domain');
    if (!accessState.allowed) {
      return res.status(402).json(buildPaymentRequiredResponse(accessState));
    }

    // Check cache
    const cacheKey = `domain::${domain}`;
    const cached = getCache(cacheKey);
    if (cached) {
      const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: false });
      if (!finalized.ok) {
        return res.status(402).json(finalized.payload);
      }
      return res.json({ fromCache: true, ...cached, access: finalized.access });
    }

    // Search Scrape Atlas for videos mentioning this domain.
    // Query is the domain wrapped in double quotes, as before.
    const needle = domain.toLowerCase();
    const wwwNeedle = `www.${needle}`;
    const matches = [];
    const coverageWarnings = [];
    let fetchedAt = "";
    let withDescription = 0;
    let totalChecked = 0;
    let continuationToken = undefined;
    let pagesSearched = 0;
    let deadlineHit = false;

    while (pagesSearched < MAX_PAGES) {
      // Only start another page if the next call can finish inside the
      // global deadline: shrink the per-call timeout to the remaining
      // budget so a slow page can never push the function past Vercel's
      // 10s limit mid-call.
      const elapsed = Date.now() - startedAt;
      const remainingMs = GLOBAL_DEADLINE_MS - elapsed;
      if (pagesSearched > 0 && remainingMs < 1500) {
        deadlineHit = true;
        break;
      }

      const data = await saGet("/v1/youtube/search", {
        tool: "domain",
        timeoutMs: Math.min(PER_CALL_TIMEOUT_MS, Math.max(remainingMs, 1000)),
        params: {
          query: `"${domain}"`,
          type: "videos",
          sortBy: "popular",
          includeExtras: true,
          ...(continuationToken ? { continuationToken } : {})
        }
      });
      pagesSearched++;

      if (data?.fetchedAt) fetchedAt = data.fetchedAt;
      if (Array.isArray(data?.coverage?.warnings)) {
        for (const warning of data.coverage.warnings) {
          if (warning && !coverageWarnings.includes(warning)) coverageWarnings.push(warning);
        }
      }

      const videos = Array.isArray(data?.videos) ? data.videos : [];
      for (const video of videos) {
        totalChecked++;
        const description = video?.description;
        const hasDescription = description !== null && description !== undefined;
        if (hasDescription) withDescription++;

        let isMatch = false;
        if (hasDescription) {
          // Same rule as the YouTube version: the domain must appear in
          // the description. A title mention alone does not count when a
          // real description was available to check.
          const lowerDescription = String(description).toLowerCase();
          isMatch = lowerDescription.includes(needle) || lowerDescription.includes(wwwNeedle);
        } else {
          // Extras were incomplete for this video (only the first 48 per
          // page are enriched), so fall back to the title rather than
          // silently dropping a video that may mention the domain.
          const lowerTitle = String(video?.title || "").toLowerCase();
          isMatch = lowerTitle.includes(needle) || lowerTitle.includes(wwwNeedle);
        }

        if (isMatch) {
          matches.push({
            videoId: video?.id || "",
            title: video?.title || "",
            channelTitle: video?.channel?.title || "",
            channelId: video?.channel?.id || "",
            publishedAt: video?.publishDate || video?.publishedTime || "",
            thumbnail: video?.thumbnail || "",
            viewCount: Number.isFinite(Number(video?.viewCountInt)) ? Number(video.viewCountInt) : 0
          });
        }
      }

      continuationToken = data?.continuationToken || undefined;
      if (!continuationToken) break;
      if (matches.length >= MAX_MATCHES) break;
    }

    // Sort by view count (most popular first) and cap at the top 50.
    matches.sort((a, b) => b.viewCount - a.viewCount);
    const topVideos = matches.slice(0, MAX_RESULTS);

    const notes = [];
    if (withDescription < totalChecked) {
      notes.push(
        `Descriptions were available for ${withDescription} of ${totalChecked} videos; ` +
        `videos without a description were only included when their title mentioned the domain.`
      );
    }
    if (deadlineHit) {
      notes.push(
        "Search stopped early to stay within the response time limit; showing the matches found so far."
      );
    }
    if (coverageWarnings.length) {
      notes.push(`Data source notes: ${coverageWarnings.join("; ")}`);
    }

    const payload = {
      domain,
      videoCount: topVideos.length,
      totalFound: matches.length,
      videos: topVideos,
      fetchedAt,
      descriptionCoverage: { withDescription, total: totalChecked },
      coverageNote: notes.length ? notes.join(" ") : null,
      coverageWarnings,
      saCreditsUsed: pagesSearched
    };

    setCache(cacheKey, payload);
    const finalized = await finalizeToolAccess(req, res, accessState, { chargeCredits: true });
    if (!finalized.ok) {
      return res.status(402).json(finalized.payload);
    }
    return res.json({ ...payload, access: finalized.access });
  } catch (err) {
    // Any Scrape Atlas failure lands here: the user is charged nothing
    // (finalizeToolAccess is never reached) and no partial result is
    // presented as complete.
    return handleApiError(res, err);
  }
}

# Promo Finder SEO Audit

Date: 2026-08-24  
Scope: Full audit of all currently public sitemap URLs supplied in the brief.

## 1) Platform and SEO implementation overview

- Framework/runtime: Node.js + Express server for local dev (`server.js`) with static HTML in `public/` and serverless API handlers in `api/`.
- Front-end architecture: Multi-page static HTML app, Tailwind CSS, shared nav injection via `public/nav.js`, per-page inline scripts.
- Routing and URL mapping:
  - Express static hosting for local dev.
  - Vercel production routing in `vercel.json` with rewrites to `public/*.html` and API routes.
  - Clean URL routes are preserved (for example `/domain` -> `public/domain.html`).
- Metadata system:
  - Per-page hardcoded `<title>`, `<meta name="description">`, `<meta name="robots">`, canonical, Open Graph, Twitter tags.
  - JSON-LD embedded per page (varies by page).
- Sitemap system: Static file at `public/sitemap.xml`.
- Robots configuration: Static `public/robots.txt` (`Allow: /` and sitemap reference).
- Shared schema pattern:
  - Core pages commonly use `WebApplication`.
  - Many pages also include `WebSite`, `Organization`, `BreadcrumbList`, `FAQPage` where implemented.
- Internal-link structure:
  - Sitewide top tool strip via `nav.js`.
  - Footer links across most pages.
  - Several tool pages include contextual “Related tools” blocks.

---

## 2) URL inventory and recommendations

Legend:
- Intent: Tool (functional), Guide (educational), Commercial (transactional), Legal.
- Action: retain, improve, consolidate, noindex, redirect, review manually.

| URL | Current title | Current meta description | Canonical | Primary H1 | Search intent | Primary keyword theme | Secondary keyword themes | Internal links pointing to it (practical) | Internal links leaving it | Existing schema types | Indexability status | Recommended action | Risks / notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | YouTube Sponsor Finder by Channel \| Find Brand Deals and Affiliate Links | Analyze any YouTube channel to find sponsors, affiliate links, brand deals, and recurring promotions from public video descriptions... | `https://promofinder.4ourmedia.com/` | YouTube Sponsor Finder by Channel | Tool | youtube sponsor finder by channel | affiliate links, brand deals, sponsor research | Sitewide from most pages | `/domain`, `/collab`, `/compare`, `/unlisted`, `/signal-desk`, legal, services | `WebSite`, `Organization`, `WebApplication`, `WebPage`, `FAQPage`, `ImageObject` | Indexable, in sitemap | Retain | Good positioning as core product. Keep commercial and research messaging separated. |
| `/domain` | Find Videos Promoting Any Brand \| YouTube Domain Mention Search | Search YouTube descriptions for a brand domain... | `https://promofinder.4ourmedia.com/domain` | Find Videos Promoting Any Brand | Tool | youtube domain mention search | competitor sponsor research, brand mention search | Homepage + sitewide + related cards | `/`, `/collab`, `/compare`, `/unlisted`, legal | `WebSite`, `Organization`, `WebApplication`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Improve | Add stronger limitations block on public-description scope and incomplete recall. |
| `/collab` | YouTube Collaboration Finder by Channel \| Creator Collaboration Research | Find YouTube collaborations by channel... | `https://promofinder.4ourmedia.com/collab` | YouTube Collaboration Finder by Channel | Tool | youtube collaboration finder | creator mentions, partner mapping | Homepage + sitewide + related cards | `/`, `/domain`, `/compare`, `/unlisted`, legal | `WebSite`, `Organization`, `WebApplication`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Improve | Clarify heuristics and non-exhaustive detection. |
| `/compare` | Compare YouTube Sponsors Between Channels \| Sponsor Comparison Tool | Compare two YouTube channels... | `https://promofinder.4ourmedia.com/compare` | Compare Creator Sponsors | Tool | compare youtube sponsors | shared sponsors, overlap analysis | Homepage + sitewide + related cards | `/`, `/domain`, `/collab`, `/unlisted`, legal | `WebSite`, `Organization`, `WebApplication`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Improve | Add explicit “how it works” and output limitations for overlap interpretation. |
| `/linkcheck` | YouTube Link Checker … Find Broken Links in Video Descriptions (Free) | Free YouTube link checker tool... | `https://promofinder.4ourmedia.com/linkcheck` | Link Checker | Tool | youtube link checker | broken links in video descriptions, affiliate link audit | Sitewide from analytics/service/legal pages | Broad links to analytics + services + legal | `WebApplication` | Indexable, in sitemap | Improve | Encoding artifacts in title/OG/Twitter; copy leans broad; needs clearer data-source limits and cleaner cluster links. |
| `/unlisted` | Unlisted YouTube Video Finder by Channel \| Public Playlist Scanner | Find unlisted YouTube videos by channel using public playlists only... | `https://promofinder.4ourmedia.com/unlisted` | Unlisted YouTube Video Finder by Channel | Tool | unlisted youtube video finder by channel | public playlist scanner, discoverable unlisted videos | Homepage + sitewide + guide pages | `/unlisted-video-finder-by-channel`, `/youtube-unlisted-video-finder`, core pages | `WebSite`, `Organization`, `WebApplication`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Retain / Improve | Strong privacy-safe framing already. Maintain strict public-only language everywhere. |
| `/unlisted-video-finder-by-channel` | Unlisted Video Finder By Channel - Free YouTube Scanner \| PromoFinder | Use this unlisted video finder by channel... | `https://promofinder.4ourmedia.com/unlisted-video-finder-by-channel` | Unlisted Video Finder By Channel | Guide | unlisted video finder by channel | by-channel workflow, playlist discovery | Linked from `/unlisted` and sibling guide | Links to `/unlisted`, sibling guide, `/youtube-downloader` | `WebPage`, `WebSite`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Improve | Some intent overlap with `/unlisted` and sibling guide. Tighten educational differentiation. |
| `/youtube-unlisted-video-finder` | YouTube Unlisted Video Finder - Find Hidden Playlist Videos \| PromoFinder | YouTube unlisted video finder guide... | `https://promofinder.4ourmedia.com/youtube-unlisted-video-finder` | YouTube Unlisted Video Finder | Guide | youtube unlisted video finder | unlisted vs private, ethical discovery | Linked from `/unlisted` and sibling guide | Links to `/unlisted`, sibling guide, `/youtube-downloader` | `WebPage`, `WebSite`, `BreadcrumbList`, `FAQPage` | Indexable, in sitemap | Improve | Must stay educational and avoid claim drift toward private access. |
| `/growth` | YouTube Channel Growth Tracker … Analyze Upload Patterns & Statistics (Free) | Free YouTube channel growth tracker... | `https://promofinder.4ourmedia.com/growth` | Channel Growth Tracker | Tool | youtube channel growth tracker | upload frequency, channel trends | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication` | Indexable, in sitemap | Improve | Encoding artifacts; missing explicit methodology and data-window limits in on-page copy. |
| `/rate` | YouTube Sponsorship Rate Calculator … How Much Do YouTubers Charge? (Free) | Free YouTube sponsorship rate calculator... | `https://promofinder.4ourmedia.com/rate` | Sponsorship Rate Estimator | Tool | youtube sponsorship rate calculator | influencer pricing estimator, brand deal rates | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication`, `FAQPage` | Indexable, in sitemap | Improve | Encoding artifacts and aggressive claim phrasing; needs uncertainty/disclosure language. |
| `/viral` | YouTube Viral Video Detector … Find Outlier Content That Explodes in Views (Free) | Free YouTube viral video detector... | `https://promofinder.4ourmedia.com/viral` | Viral Video Detector | Tool | youtube viral video detector | outlier video analysis | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication` | Indexable, in sitemap | Improve | Encoding artifacts in metadata; potential overlap with predictor unless intent boundaries are explicit. |
| `/bot-detector` | YouTube Bot Detector \| Audit Suspicious Views, Subs, and Comments (Free) | Free YouTube bot detector... | `https://promofinder.4ourmedia.com/bot-detector` | YouTube Bot Detector | Tool | youtube bot detector | suspicious engagement audit | Homepage + sitewide | Links to selected research pages + services | `WebApplication` | Indexable, in sitemap | Improve | Add compact “how it works” and clear non-definitive heuristic disclaimer near top. |
| `/saturation` | YouTube Sponsor Saturation Checker … Is a Channel Over-Sponsored? (Free) | Free YouTube sponsor saturation checker... | `https://promofinder.4ourmedia.com/saturation` | Sponsor Saturation Score | Tool | youtube sponsor saturation checker | sponsor frequency analysis | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication` | Indexable, in sitemap | Improve | Encoding artifacts and overlap risk with sponsorship-rate/revenue pages. |
| `/revenue` | YouTube Revenue Calculator … Estimate Any Channel's Ad Earnings (Free) | Free YouTube revenue calculator... | `https://promofinder.4ourmedia.com/revenue` | YouTube Revenue Calculator | Tool | youtube revenue calculator | estimated ad earnings, CPM estimates | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication`, `FAQPage` | Indexable, in sitemap | Improve | Encoding artifacts and certainty risk; strengthen estimate-only disclosure. |
| `/predictor` | YouTube Video Performance Predictor … Forecast Views Before You Publish (Free) | Free YouTube video performance predictor... | `https://promofinder.4ourmedia.com/predictor` | Video Performance Predictor | Tool | youtube video performance predictor | posting time, title length prediction | Sitewide + analytics cluster | Broad links to analytics + services | `WebApplication` | Indexable, in sitemap | Improve | Encoding artifacts and overlap risk with viral/growth pages. |
| `/tiktok` | TikTok Downloader - Save TikTok Videos and Audio (Free) | Free TikTok downloader... | `https://promofinder.4ourmedia.com/tiktok` | TikTok Downloader | Tool | tiktok downloader | video/audio download utility | Sitewide links from multiple pages | Broad links to other tools/services | None detected | Indexable, in sitemap | Improve | Utility should remain separate cluster with restrained crossover links to sponsor research tools. |
| `/youtube-downloader` | YouTube Downloader Online - Download YouTube Video and Audio Free | Free YouTube downloader online... | `https://promofinder.4ourmedia.com/youtube-downloader` | YouTube Downloader | Tool | youtube downloader online | video/audio download utility | Sitewide + unlisted guides | Broad links to analytics/services and unlisted guide | `FAQPage`, `HowTo` | Indexable, in sitemap | Improve | Needs careful policy-safe wording and restrained cluster crossover. |
| `/ad-library-finder` | Ad Library Finder - Search Facebook, Google, TikTok, LinkedIn Ad Libraries | Free Ad Library Finder... | `https://promofinder.4ourmedia.com/ad-library-finder` | Ad Library Finder | Tool | ad library finder | cross-platform ad transparency search | Limited incoming beyond self/sitewide | Links include `/domain`, `/compare`, `/services`, `/unlisted` | `WebApplication`, `WebPage`, `BreadcrumbList`, `FAQPage`, `HowTo` | Indexable, in sitemap | Improve | Clarify this as ad-transparency utility cluster, not core YouTube sponsor finder. |
| `/services` | Buy Social Media Followers, Likes & Views \| PromoFinder | Buy real social media growth services... | `https://promofinder.4ourmedia.com/services` | Buy Followers, Likes & Views — Grow Any Platform Fast | Commercial | buy social media followers likes views | social growth services checkout | Sitewide and service pages | Links to multiple research tools and service product pages | `Service`, `OfferCatalog`, `FAQPage`, `BreadcrumbList`, `WebPage`, `WebSite` | Indexable, in sitemap | Improve | Keep clear boundary between commercial services and research-tool outcomes. |
| `/buy-youtube-subscribers` | Buy YouTube Subscribers - Secure Checkout and Fast Delivery \| PromoFinder | Buy YouTube subscribers with secure Stripe checkout... | `https://promofinder.4ourmedia.com/buy-youtube-subscribers` | Buy YouTube Subscribers with Secure Checkout | Commercial | buy youtube subscribers | social proof services | Incoming mainly from services pages | Links to sibling service pages + `/services` | `Service`, `Offer`, `FAQPage`, `BreadcrumbList` | Indexable, in sitemap | Retain / Review | High policy/reputation sensitivity. Do not change conversion/legal claims without approval. |
| `/buy-youtube-views` | Buy YouTube Views - Fast Delivery and Secure Checkout \| PromoFinder | Buy YouTube views with secure Stripe checkout... | `https://promofinder.4ourmedia.com/buy-youtube-views` | Buy YouTube Views with Secure Checkout | Commercial | buy youtube views | campaign view services | Incoming mainly from services pages | Links to sibling service pages + `/services` | `Service`, `Offer`, `FAQPage`, `BreadcrumbList` | Indexable, in sitemap | Retain / Review | Same sensitivity as above. |
| `/buy-instagram-likes` | Buy Instagram Likes - Secure Checkout and Fast Delivery \| PromoFinder | Buy Instagram likes for posts and reels... | `https://promofinder.4ourmedia.com/buy-instagram-likes` | Buy Instagram Likes with Secure Checkout | Commercial | buy instagram likes | social engagement services | Incoming mainly from services pages | Links to sibling service pages + `/services` | `Service`, `Offer`, `FAQPage`, `BreadcrumbList` | Indexable, in sitemap | Retain / Review | Same sensitivity as above. |
| `/buy-tiktok-followers` | Buy TikTok Followers - Secure Checkout and Fast Queue Entry \| PromoFinder | Buy TikTok followers with secure Stripe checkout... | `https://promofinder.4ourmedia.com/buy-tiktok-followers` | Buy TikTok Followers with Secure Checkout | Commercial | buy tiktok followers | social growth services | Incoming mainly from services pages | Links to sibling service pages + `/services` | `Service`, `Offer`, `FAQPage`, `BreadcrumbList` | Indexable, in sitemap | Retain / Review | Same sensitivity as above. |
| `/signal-desk` | ANAMNESIS Signal Desk \| Manual-First Trading Copilot | ANAMNESIS Signal Desk turns self-learning market memory... | `https://promofinder.4ourmedia.com/signal-desk` | ANAMNESIS Signal Desk | Product | manual-first trading copilot | trading workflow, market memory | Homepage feature + self links | `/services`, `/domain`, `/compare`, legal | `Service`, `FAQPage`, `BreadcrumbList`, `WebPage`, `WebSite`, `Organization` | Indexable, in sitemap | Improve | Keep as standalone product with restrained cross-promo from YouTube tool pages. |
| `/privacy` | Privacy Policy - YouTube Promo Finder | Missing | Missing | Privacy Policy | Legal | privacy policy | data handling terms | Sitewide footer links | Tool cluster links in nav/footer | None | Indexable by default, **not in sitemap currently** | Improve | Missing meta description, canonical, robots, sitemap inclusion. |
| `/terms` | Terms of Service - YouTube Promo Finder | Missing | Missing | Missing | Legal | terms of service | usage terms | Sitewide footer links | Tool cluster links in nav/footer | None | Indexable by default, **not in sitemap currently** | Improve | Missing H1, meta description, canonical, robots, sitemap inclusion. |
| `/disclaimer` | Disclaimer - YouTube Promo Finder | Missing | Missing | Missing | Legal | disclaimer | limitations of liability | Sitewide footer links | Tool cluster links in nav/footer | None | Indexable by default, **not in sitemap currently** | Improve | Missing H1, meta description, canonical, robots, sitemap inclusion. |

---

## 3) Duplicate-intent review notes

### Unlisted cluster

- `/unlisted` is correctly positioned as the functional tool page.
- `/unlisted-video-finder-by-channel` and `/youtube-unlisted-video-finder` are both educational and partially overlapping.
- Needed differentiation:
  - `/unlisted-video-finder-by-channel`: procedural by-channel workflow and practical input formats.
  - `/youtube-unlisted-video-finder`: concept-level education, unlisted vs private, ethical public discovery constraints.
- Action: improve copy and internal-link differentiation. Do **not** consolidate, redirect, or cross-canonicalize without human approval.

### Creator analytics cluster

Overlap risk exists among:
- `/growth` (channel cadence and trend baseline)
- `/viral` (outlier content detection)
- `/predictor` (forward-looking publishing guidance)
- `/rate` (sponsorship pricing estimate)
- `/revenue` (ad-earnings estimate)
- `/saturation` (commercial load and audience fatigue signal)

Action: keep each page focused on unique outcome, input, and audience, and tighten related-links by sub-intent.

---

## 4) Phase-1 non-implementation flags requiring human approval

The following are flagged only, not actioned in Phase 1:

- Any redirects or consolidation between unlisted guide pages.
- Any noindex decisions for legal, utility, or commercial pages.
- Any URL changes.
- Any legal policy text rewrites.
- Any changes to service-page commercial claims that could affect legal or policy positioning.

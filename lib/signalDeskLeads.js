import { get, list, put } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";
import { applyApiGuards, handleApiError } from "../utils.js";

const LEADS_PREFIX = "signal-desk/leads/";
const MAX_LEAD_FETCH = 200;
const LEAD_STATUSES = new Set(["new", "contacted", "qualified", "waitlist", "closed"]);

function asString(value, maxLen = 4000) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLen);
}

function hasBlobStorage() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN
      || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)
  );
}

function setSignalDeskCors(res, methods) {
  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Request-ID, Authorization");
}

function parseJsonBody(req) {
  const body = req?.body;
  if (!body) return {};
  if (typeof body === "object" && !Buffer.isBuffer(body)) return body;

  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : asString(body, 20_000);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeSubmittedAt(input) {
  const raw = asString(input, 120);
  if (!raw) return new Date().toISOString();

  let candidate = raw.replace(" ", "T").replace(/\.(\d{3})\d+/, ".$1");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)) {
    candidate += "Z";
  }

  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(email, 320));
}

function normalizeWebhookPayload(payload) {
  const formData = payload?.form_data && typeof payload.form_data === "object"
    ? payload.form_data
    : payload;

  return {
    name: asString(formData?.name, 160),
    email: asString(formData?.email, 320).toLowerCase(),
    markets: asString(formData?.markets, 240),
    timeframe: asString(formData?.timeframe, 160),
    experience: asString(formData?.experience, 120),
    goals: asString(formData?.goals, 4000),
    source: asString(formData?.source || "ANAMNESIS Signal Desk", 160),
    formUrl: asString(payload?.form_url || formData?._next || "", 400),
    submittedAt: normalizeSubmittedAt(payload?.submitted_at?.date || formData?.submitted_at || formData?.created_at || "")
  };
}

function isValidLead(lead) {
  return Boolean(
    lead.name
      && looksLikeEmail(lead.email)
      && lead.markets
      && lead.timeframe
      && lead.experience
      && lead.goals
  );
}

function buildLeadId(lead) {
  const hash = createHash("sha256")
    .update([lead.email.toLowerCase(), lead.submittedAt, lead.goals].join("|"))
    .digest("hex")
    .slice(0, 12);

  return `sd_${lead.submittedAt.slice(0, 10).replace(/-/g, "")}_${hash}`;
}

function buildLeadPathname(lead) {
  const day = lead.submittedAt.slice(0, 10);
  return `${LEADS_PREFIX}${day}/${lead.id}.json`;
}

function toLeadRecord(lead) {
  const id = buildLeadId(lead);
  const pathname = buildLeadPathname({ ...lead, id });
  const now = new Date().toISOString();

  return {
    id,
    pathname,
    createdAt: lead.submittedAt,
    updatedAt: now,
    status: "new",
    adminNotes: "",
    contactedAt: null,
    closedAt: null,
    name: lead.name,
    email: lead.email,
    markets: lead.markets,
    timeframe: lead.timeframe,
    experience: lead.experience,
    goals: lead.goals,
    source: lead.source,
    formUrl: lead.formUrl || null
  };
}

async function readPrivateJson(pathname) {
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    return null;
  }

  const text = await new Response(result.stream).text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeLeadRecord(record) {
  await put(record.pathname, JSON.stringify(record, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60
  });
}

async function listLeadRecords(limit = MAX_LEAD_FETCH, statusFilter = "") {
  const entries = [];
  let cursor;
  let hasMore = true;

  while (hasMore && entries.length < limit) {
    const remaining = Math.max(1, Math.min(100, limit - entries.length));
    const result = await list({ prefix: LEADS_PREFIX, limit: remaining, cursor });
    entries.push(...result.blobs);
    hasMore = Boolean(result.hasMore && result.cursor && entries.length < limit);
    cursor = result.cursor;
  }

  const records = await Promise.all(
    entries
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .map((item) => readPrivateJson(item.pathname))
  );

  return records
    .filter(Boolean)
    .filter((lead) => !statusFilter || lead.status === statusFilter)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function summarizeLeads(leads) {
  const summary = {
    total: leads.length,
    new: 0,
    contacted: 0,
    qualified: 0,
    waitlist: 0,
    closed: 0
  };

  for (const lead of leads) {
    const status = LEAD_STATUSES.has(lead?.status) ? lead.status : "new";
    summary[status] += 1;
  }

  return summary;
}

function decodeBasicAuth(req) {
  const header = asString(req?.headers?.authorization || "", 4000);
  if (!header.toLowerCase().startsWith("basic ")) return null;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function safeStringCompare(actual, expected) {
  const left = Buffer.from(asString(actual, 400), "utf8");
  const right = Buffer.from(asString(expected, 400), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireAdminAuth(req, res) {
  const username = asString(process.env.SIGNAL_DESK_ADMIN_USERNAME || "david", 80);
  const password = asString(process.env.SIGNAL_DESK_ADMIN_PASSWORD, 200);

  if (!password) {
    res.status(503).json({ error: "Signal Desk admin access is not configured yet." });
    return false;
  }

  const credentials = decodeBasicAuth(req);
  if (!credentials) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Signal Desk Leads"');
    res.status(401).json({ error: "Authentication required." });
    return false;
  }

  if (!safeStringCompare(credentials.username, username) || !safeStringCompare(credentials.password, password)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Signal Desk Leads"');
    res.status(401).json({ error: "Invalid credentials." });
    return false;
  }

  return true;
}

function normalizeStatus(input, fallback = "new") {
  const status = asString(input, 40).toLowerCase();
  return LEAD_STATUSES.has(status) ? status : fallback;
}

export async function handleSignalDeskWebhook(req, res) {
  if (applyApiGuards(req, res, {
    rateKey: "signal-desk-webhook",
    maxRequests: 20,
    windowMs: 60_000,
    skipMethods: [],
    rateLimit: req.method !== "OPTIONS"
  })) return;

  setSignalDeskCors(res, ["POST", "OPTIONS"]);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    if (!hasBlobStorage()) {
      return res.status(503).json({ error: "Signal Desk lead storage is not configured." });
    }

    const normalized = normalizeWebhookPayload(parseJsonBody(req));
    if (!isValidLead(normalized)) {
      return res.status(400).json({ error: "Invalid lead payload." });
    }

    const record = toLeadRecord(normalized);
    const existing = await readPrivateJson(record.pathname);
    const merged = existing
      ? {
          ...existing,
          ...record,
          status: existing.status || record.status,
          adminNotes: existing.adminNotes || "",
          contactedAt: existing.contactedAt || null,
          closedAt: existing.closedAt || null,
          updatedAt: new Date().toISOString()
        }
      : record;

    await writeLeadRecord(merged);
    return res.status(200).json({ ok: true, id: merged.id });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}

export async function handleSignalDeskLeads(req, res) {
  if (applyApiGuards(req, res, {
    rateKey: "signal-desk-leads",
    maxRequests: 30,
    windowMs: 60_000,
    skipMethods: [],
    rateLimit: req.method !== "OPTIONS"
  })) return;

  setSignalDeskCors(res, ["GET", "PATCH", "OPTIONS"]);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!requireAdminAuth(req, res)) {
    return;
  }

  try {
    if (!hasBlobStorage()) {
      return res.status(503).json({ error: "Signal Desk lead storage is not configured." });
    }

    if (req.method === "GET") {
      const status = normalizeStatus(req?.query?.status, "");
      const leads = await listLeadRecords(MAX_LEAD_FETCH, status);
      return res.json({
        leads,
        summary: summarizeLeads(leads)
      });
    }

    if (req.method === "PATCH") {
      const payload = parseJsonBody(req);
      const pathname = asString(payload?.pathname, 240);
      if (!pathname) {
        return res.status(400).json({ error: "Lead pathname is required." });
      }

      const existing = await readPrivateJson(pathname);
      if (!existing) {
        return res.status(404).json({ error: "Lead not found." });
      }

      const nextStatus = normalizeStatus(payload?.status, existing.status || "new");
      const now = new Date().toISOString();
      const updated = {
        ...existing,
        status: nextStatus,
        adminNotes: asString(payload?.adminNotes, 4000),
        updatedAt: now,
        contactedAt: existing.contactedAt || (nextStatus !== "new" ? now : null),
        closedAt: nextStatus === "closed" ? (existing.closedAt || now) : null
      };

      await writeLeadRecord(updated);
      return res.json({ ok: true, lead: updated });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return handleApiError(res, error, req);
  }
}
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export const API_KEY = process.env.YOUTUBE_API_KEY;

const QUOTA_FILE = process.env.VERCEL 
  ? path.join("/tmp", "quota.json") 
  : path.join(process.cwd(), "quota.json");

const DAILY_LIMIT = 10000;

export function consumeQuota(cost) {
  const today = new Date().toISOString().split("T")[0];
  let currentUsed = 0;
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
      if (data.date === today) {
        currentUsed = data.used;
      }
    }
  } catch (e) {}

  if (currentUsed + cost > DAILY_LIMIT) {
    throw new Error(`Daily YouTube API quota exceeded. Used: ${currentUsed}, Cost: ${cost}, Limit: ${DAILY_LIMIT}`);
  }

  const newUsed = currentUsed + cost;
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: today, used: newUsed }));
  } catch (e) {
    console.error("Error writing quota file:", e);
  }
  return newUsed;
}

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${txt}`);
  }
  return res.json();
}

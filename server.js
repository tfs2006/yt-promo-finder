import express from "express";
import * as dotenv from "dotenv";
import { API_KEY } from "./utils.js";

// Import API handlers for local development
import collabHandler from "./api/collab.js";
import growthHandler from "./api/growth.js";
import unlistedHandler from "./api/unlisted.js";
import analyzeHandler from "./api/analyze.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.warn("[WARN] No YOUTUBE_API_KEY found in environment. Set it in your .env file.");
}

app.use(express.static("public", { extensions: ["html"] }));

// Register API routes for local development
app.get("/api/analyze", analyzeHandler);
app.get("/api/collab", collabHandler);
app.get("/api/growth", growthHandler);
app.get("/api/unlisted", unlistedHandler);

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

export default app;
import "dotenv/config";
import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { processJob } from "./pipeline/processJob.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "25mb" }));

const supabaseUrl = process.env.SUPABASE_URL || "https://placeholder.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder_key";
const replicateApiToken = process.env.REPLICATE_API_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

if (!replicateApiToken) {
  console.warn("Missing REPLICATE_API_TOKEN");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/process-job", async (req, res) => {
  console.log("[Zoora Backend] process-job called");
  try {
    const { image, prompt } = req.body;

    if (!image || !prompt) {
      return res.status(400).json({ error: "Missing image or prompt" });
    }

    // Call existing processJob logic
    const result = await processJob({ image, prompt });
    
    // Expected handling based on result type:
    if (Buffer.isBuffer(result)) {
      res.setHeader("Content-Type", "image/png");
      return res.send(result);
    }
    return res.status(200).json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api] ERROR:", message);
    return res.status(500).json({ error: message });
  }
});

// Console logs showing registered routes
console.log("[Zoora Backend] Registered route: GET /health");
console.log("[Zoora Backend] Registered route: POST /process-job");

app.listen(PORT, () => {
  console.log("[Zoora Backend] Server started");
  console.log(`✅ Zoora backend running on port ${PORT}`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
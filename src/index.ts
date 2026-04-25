import express from "express";
import { createClient } from "@supabase/supabase-js";

import { ENV } from "./config/env.js";
import { processJob } from "./pipeline/processJob.js";

const app = express();
const PORT = ENV.PORT;

app.use(express.json({ limit: "25mb" }));

console.log("[ENV] Checking environment variables...");
void ENV.REPLICATE_API_TOKEN;
void ENV.BG_MODEL_FAST;
void ENV.BG_MODEL_PRO;
void ENV.MAX_BG_RETRIES_FAST;
void ENV.MAX_BG_RETRIES_PRO;
void ENV.GUARDIAN_STRICTNESS;
void ENV.SUPABASE_URL;
void ENV.SUPABASE_SERVICE_ROLE_KEY;
void ENV.PORT;
console.log("[ENV] Loaded Replicate token OK");
console.log("[ENV] Environment variables ready");

const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/analyze-product", async (req, res) => {
  console.log("[Zoora Backend] POST /analyze-product called");
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "Missing image" });
    }
    const { analyzeProductWithAI } = await import("./pipeline/aiAnalyzer.js");
    const result = await analyzeProductWithAI(image);
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api] /analyze-product ERROR:", message);
    return res.status(500).json({ error: message });
  }
});

app.post("/process-job", async (req, res) => {
  console.log("[Zoora Backend] process-job called");
  try {
    const { image, prompt, enhanceMode, productCategory, productType, subcategory } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Missing image" });
    }

    // Call existing processJob logic
    const result = await processJob({ image, prompt, enhanceMode, productCategory, productType, subcategory });
    
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

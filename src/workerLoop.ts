import { createClient } from "@supabase/supabase-js";
import { ENV } from "./config/env.js";
import { processJob } from "./pipeline/processJob.js";

console.log("[ENV] Checking environment variables...");
void ENV.REPLICATE_API_TOKEN;
void ENV.BG_MODEL_FAST;
void ENV.BG_MODEL_PRO;
void ENV.MAX_BG_RETRIES;
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function workerLoop() {
  console.log("[Worker] Worker started. Polling for jobs...");

  while (true) {
    try {
      const { data: jobs, error: fetchError } = await supabase
        .from("generation_jobs")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

      if (fetchError) {
        console.error("[Worker] Error fetching jobs:", fetchError.message);
        await delay(2000);
        continue;
      }

      if (!jobs || jobs.length === 0) {
        await delay(2000);
        continue;
      }

      const job = jobs[0];
      console.log(`[Worker] Processing job: ${job.id}`);

      const attempts = (job.attempts || 0) + 1;

      const { error: lockError } = await supabase
        .from("generation_jobs")
        .update({
          status: "processing",
          attempts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (lockError) {
        console.error(`[Worker] Failed to lock job ${job.id}:`, lockError.message);
        await delay(2000);
        continue;
      }

      try {
        const resultBuffer = await processJob(job.input);

        const filename = `${job.id}-${Date.now()}.png`;
        const { error: storageError } = await supabase.storage
          .from("generated-images")
          .upload(filename, resultBuffer, {
            contentType: "image/png",
            upsert: true
          });

        if (storageError) {
          throw new Error(`Storage upload failed: ${storageError.message}`);
        }

        const { data: { publicUrl } } = supabase.storage
          .from("generated-images")
          .getPublicUrl(filename);

        await supabase
          .from("generation_jobs")
          .update({
            status: "completed",
            progress: 100,
            output_image: publicUrl,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        console.log(`[Worker] Job completed: ${job.id}`);
      } catch (jobError: any) {
        console.error(`[Worker] Job failed: ${job.id}`, jobError.message);

        const isRetryable = attempts < 3;
        const newStatus = isRetryable ? "pending" : "failed";

        if (isRetryable) {
          console.log(`[Worker] Retrying job: ${job.id} (Attempt ${attempts}/3)`);
        }

        await supabase
          .from("generation_jobs")
          .update({
            status: newStatus,
            error: jobError.message || String(jobError),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }

      await delay(2000);
    } catch (err) {
      console.error("[Worker] Unexpected worker error:", err);
      await delay(2000);
    }
  }
}

workerLoop();

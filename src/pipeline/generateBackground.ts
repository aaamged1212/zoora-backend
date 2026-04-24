import { runReplicate } from "./replicateHelper.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateBackground(prompt: string): Promise<string> {
  console.log(`[Pipeline] 3/4: Generating background for prompt: "${prompt}"...`);
  
  let cleanPrompt = prompt.replace(/black background/gi, "").replace(/dark background/gi, "").trim();
  
  if (prompt.toLowerCase().includes("luxury")) {
    cleanPrompt = "premium studio background with dark navy and deep purple gradient, soft gold rim lighting, reflective surface, visible environment depth, elegant shadows, commercial product photography, not pure black";
  }

  const finalPrompt = cleanPrompt
    ? `${cleanPrompt}, empty background, no product, no object, clean scene, professional studio lighting, depth of field, high quality, photorealistic, soft shadows, cinematic lighting`
    : `empty background, no product, no object, clean scene, professional studio lighting, depth of field, high quality, photorealistic, soft shadows, cinematic lighting`;

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      console.log("[BG] sending request...");
      console.log("[BG] prompt:", finalPrompt);
      
      const output = await runReplicate(
        "black-forest-labs/flux-schnell",
        {
          prompt: finalPrompt,
          negative_prompt: "pure black background, empty black screen, flat color, underexposed, no details, product, object, text, logo, watermark",
          width: 1024,
          height: 1024
        }
      );
      
      console.log("[BG] raw output:", output);
      
      const resultUrl = Array.isArray(output) ? output[0] : output;
      
      if (!resultUrl || typeof resultUrl !== "string") {
        throw new Error("Background generation failed: invalid output");
      }
      
      console.log("[BG] final URL:", resultUrl);
      return resultUrl;
    } catch (error: any) {
      attempt++;
      console.error("[BG] failed:", error.message);
      
      if (attempt >= maxAttempts) {
        return "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee";
      }
      
      const waitTime = Math.pow(2, attempt) * 1000;
      await delay(waitTime);
    }
  }

  return "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee";
}
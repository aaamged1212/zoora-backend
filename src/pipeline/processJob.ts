import sharp from "sharp";
import axios from "axios";
import { removeBackground } from "./rembg.js";
import { generateBackground } from "./generateBackground.js";
import { enhanceProduct, type EnhanceMode } from "./enhance.js";
import { composeImages } from "./compose.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEnhanceMode(mode?: string): EnhanceMode {
  return mode === "pro" ? "pro" : "fast";
}

export async function processJob(input: {
  image: string;
  prompt?: string;
  enhanceMode?: string;
}): Promise<Buffer> {
  console.log("[worker] Starting job pipeline...");
  let { image } = input;
  const { prompt } = input;
  const enhanceMode = normalizeEnhanceMode(input.enhanceMode);

  if (!image) {
    throw new Error("Input must contain an 'image' URL.");
  }

  // 0. Resize initial input image to avoid Replicate GPU memory limits
  console.log("[worker] Fetching and resizing original input image...");
  let initialBuffer: Buffer;
  if (image.startsWith("data:")) {
    initialBuffer = Buffer.from(image.split(",")[1], "base64");
  } else {
    const res = await axios.get(image, { responseType: "arraybuffer" });
    initialBuffer = Buffer.from(res.data);
  }

  const initialResizedBuffer = await sharp(initialBuffer)
    .autoOrient()
    .resize({
      width: 1400,
      height: 1400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  image = `data:image/png;base64,${initialResizedBuffer.toString("base64")}`;

  // 1. Remove background
  console.log("[Pipeline] 1/4: Removing background...");
  const cutout = await removeBackground(image);
  
  await delay(1500);

  // 1.5. Prepare cutout for enhancement. enhanceProduct performs the AI-safe resize.
  console.log("[worker] Preparing cutout image for enhancement...");
  let cutoutBuffer: Buffer;
  if (cutout.startsWith("data:")) {
    cutoutBuffer = Buffer.from(cutout.split(",")[1], "base64");
  } else {
    const res = await axios.get(cutout, { responseType: "arraybuffer" });
    cutoutBuffer = Buffer.from(res.data);
  }

  console.log("[Pipeline] 2/4: Enhancing resized product...");
  let finalEnhancedBuffer = await enhanceProduct(cutoutBuffer, { mode: enhanceMode });

  try {
    finalEnhancedBuffer = await sharp(finalEnhancedBuffer)
      .ensureAlpha()
      .sharpen({ sigma: 1.5 })
      .modulate({ brightness: 1.08, saturation: 1.1 })
      .linear(1.05, -5)
      .png()
      .toBuffer();

    console.log("[Enhance] Final image ready");
  } catch (criticalError: any) {
    console.error("[Enhance] CRITICAL ERROR:", criticalError.message);
    throw new Error("Enhancement pipeline failed");
  }

  const finalEnhancedCutoutUrl = `data:image/png;base64,${finalEnhancedBuffer.toString("base64")}`;

  await delay(1500);

  // 3. Generate background
  console.log("[Pipeline] 3/4: Generating background...");
  const bg = await generateBackground(prompt || "studio lighting background");

  // 4. Composite
  console.log("[Pipeline] 4/4: Compositing final image...");
  const finalImage = await composeImages(bg, finalEnhancedCutoutUrl);

  console.log("[worker] Final image ready.");
  return finalImage;
}

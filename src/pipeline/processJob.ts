import sharp from "sharp";
import axios from "axios";
import { removeBackground } from "./rembg.js";
import { generateBackground } from "./generateBackground.js";
import { enhanceImage } from "./enhance.js";
import { composeImages } from "./compose.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function processJob(input: { image: string; prompt?: string }): Promise<Buffer> {
  console.log("[worker] Starting job pipeline...");
  let { image } = input;
  const { prompt } = input;

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

  // 1.5. Resize cutout to prevent enhancer GPU memory issues
  console.log("[worker] Preparing cutout image for resizing...");
  let cutoutBuffer: Buffer;
  if (cutout.startsWith("data:")) {
    cutoutBuffer = Buffer.from(cutout.split(",")[1], "base64");
  } else {
    const res = await axios.get(cutout, { responseType: "arraybuffer" });
    cutoutBuffer = Buffer.from(res.data);
  }

  const metadata = await sharp(cutoutBuffer).metadata();
  console.log("[Enhance] Original size:", metadata.width, metadata.height);

  let resizedBuffer = await sharp(cutoutBuffer)
    .ensureAlpha()
    .resize({
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
    })
    .sharpen()
    .modulate({ brightness: 1.05, saturation: 1.05 })
    .png()
    .toBuffer();

  let resizedMeta = await sharp(resizedBuffer).metadata();
  console.log("[Enhance] Resized size:", resizedMeta.width, resizedMeta.height);
  console.log("[Enhance] Preprocess complete");

  const resizedCutoutUrl = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] Sending to AI");
  console.log("[Enhance] Primary AI enhance started");
  console.log("[Pipeline] 2/4: Enhancing resized product...");

  let finalEnhancedBuffer: Buffer | null = null;
  let aiSuccess = false;

  try {
    const enhancedOutput = await enhanceImage(resizedCutoutUrl);
    if (!enhancedOutput || typeof enhancedOutput !== 'string' || (!enhancedOutput.startsWith('http') && !enhancedOutput.startsWith('data:'))) {
      throw new Error("Invalid AI enhancement output");
    }
    console.log("[Enhance] AI success");
    aiSuccess = true;

    if (enhancedOutput.startsWith("data:")) {
      finalEnhancedBuffer = Buffer.from(enhancedOutput.split(",")[1], "base64");
    } else {
      const res = await axios.get(enhancedOutput, { responseType: "arraybuffer" });
      finalEnhancedBuffer = Buffer.from(res.data);
    }
  } catch (error: any) {
    console.warn(`[Enhance] AI failed -> fallback: ${error.message}`);

    try {
      let fallbackBuffer = await sharp(cutoutBuffer)
        .ensureAlpha()
        .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
        .sharpen()
        .modulate({ brightness: 1.05, saturation: 1.05 })
        .png()
        .toBuffer();

      let fallbackCutoutUrl = `data:image/png;base64,${fallbackBuffer.toString("base64")}`;
      const enhancedOutput = await enhanceImage(fallbackCutoutUrl);

      if (!enhancedOutput || typeof enhancedOutput !== 'string' || (!enhancedOutput.startsWith('http') && !enhancedOutput.startsWith('data:'))) {
        throw new Error("Invalid AI fallback output");
      }

      console.log("[Enhance] AI success");
      aiSuccess = true;

      if (enhancedOutput.startsWith("data:")) {
        finalEnhancedBuffer = Buffer.from(enhancedOutput.split(",")[1], "base64");
      } else {
        const res = await axios.get(enhancedOutput, { responseType: "arraybuffer" });
        finalEnhancedBuffer = Buffer.from(res.data);
      }
    } catch (retryError: any) {
      console.log("[Enhance] Fallback used");
      aiSuccess = false;
    }
  }

  try {
    if (!aiSuccess || !finalEnhancedBuffer) {
      finalEnhancedBuffer = await sharp(cutoutBuffer)
        .ensureAlpha()
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .sharpen({ sigma: 1.2 })
        .modulate({ brightness: 1.08, saturation: 1.1 })
        .png()
        .toBuffer();
    }

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
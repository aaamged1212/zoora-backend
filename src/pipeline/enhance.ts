import axios from "axios";
import sharp from "sharp";
import { ENV } from "../config/env.js";
import { runReplicate } from "./replicateHelper.js";

export type EnhanceMode = "fast" | "pro" | "ultra";

type EnhanceOptions = {
  mode?: EnhanceMode;
};

function normalizeMode(mode?: string): EnhanceMode {
  if (mode === "pro" || mode === "ultra") {
    return mode;
  }

  return "fast";
}

async function inputToBuffer(imageInput: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(imageInput)) {
    return imageInput;
  }

  if (imageInput.startsWith("data:")) {
    return Buffer.from(imageInput.split(",")[1], "base64");
  }

  const res = await axios.get(imageInput, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function replicateOutputToBuffer(output: unknown): Promise<Buffer> {
  const resultUrl = Array.isArray(output) ? output[0] : output;

  if (!resultUrl || typeof resultUrl !== "string") {
    throw new Error("Invalid enhancement output");
  }

  let outputBuffer: Buffer;
  if (resultUrl.startsWith("data:")) {
    outputBuffer = Buffer.from(resultUrl.split(",")[1], "base64");
  } else if (resultUrl.startsWith("http")) {
    const res = await axios.get(resultUrl, { responseType: "arraybuffer" });
    outputBuffer = Buffer.from(res.data);
  } else {
    throw new Error("Invalid enhancement output URL");
  }

  return outputBuffer;
}

async function resizeForAi(inputBuffer: Buffer): Promise<Buffer> {
  const originalMeta = await sharp(inputBuffer).metadata();
  console.log("[Enhance] original dimensions:", originalMeta.width, originalMeta.height);

  const resizedBuffer = await sharp(inputBuffer)
    .autoOrient()
    .ensureAlpha()
    .resize({
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const resizedMeta = await sharp(resizedBuffer).metadata();
  console.log("[Enhance] resized dimensions:", resizedMeta.width, resizedMeta.height);

  return resizedBuffer;
}

async function enhanceCutoutLocal(inputBuffer: Buffer): Promise<Buffer> {
  console.log("[Enhance] Cutout enhancement: local alpha-safe only");
  console.log("[Enhance] AI cutout enhancement disabled");

  const enhancedBuffer = await sharp(inputBuffer)
    .ensureAlpha()
    .sharpen({ sigma: 1.1 })
    .modulate({ brightness: 1.04, saturation: 1.05 })
    .png()
    .toBuffer();

  const metadata = await sharp(enhancedBuffer).metadata();
  console.log("[Enhance] cutout channels after local enhancement:", metadata.channels);

  if (metadata.channels !== 4) {
    throw new Error("Cutout alpha lost before compose");
  }

  return enhancedBuffer;
}

async function runUltraSupirFinalPolish(resizedBuffer: Buffer): Promise<Buffer> {
  const model = `cjwbw/supir-v0q:${ENV.REPLICATE_SUPIR_VERSION}`;
  const image = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] sending to Replicate: ultra");
  const output = await runReplicate(model, { image });
  const outputBuffer = await replicateOutputToBuffer(output);

  await validateUltraOutput(outputBuffer);

  console.log("[Enhance] success: ultra");
  return sharp(outputBuffer).png().toBuffer();
}

export async function enhanceProduct(
  imageInput: string | Buffer,
  options: EnhanceOptions = {}
): Promise<Buffer> {
  normalizeMode(options.mode);

  const inputBuffer = await inputToBuffer(imageInput);
  return enhanceCutoutLocal(inputBuffer);
}

export async function enhanceImage(imageUrl: string): Promise<string> {
  const enhancedBuffer = await enhanceProduct(imageUrl, { mode: "fast" });
  return `data:image/png;base64,${enhancedBuffer.toString("base64")}`;
}

async function localFinalPolish(composedImage: Buffer): Promise<Buffer> {
  return sharp(composedImage)
    .sharpen({ sigma: 0.8 })
    .modulate({ brightness: 1.02, saturation: 1.04 })
    .linear(1.03, -2)
    .png()
    .toBuffer();
}

async function validateUltraOutput(outputBuffer: Buffer): Promise<void> {
  if (outputBuffer.length < 1024) {
    throw new Error("SUPIR output rejected: invalid output size");
  }

  const metadata = await sharp(outputBuffer).metadata();
  if (!metadata.width || !metadata.height || !metadata.channels) {
    throw new Error("SUPIR output rejected: invalid metadata");
  }

  const stats = await sharp(outputBuffer).stats();
  const rgbChannels = stats.channels.slice(0, 3);
  if (rgbChannels.length < 3) {
    throw new Error("SUPIR output rejected: invalid metadata");
  }

  const meanRgb = rgbChannels.reduce((sum, channel) => sum + channel.mean, 0) / 3;
  if (meanRgb > 235) {
    throw new Error("SUPIR output rejected: overexposed");
  }
}

export async function finalPolish(composedImage: Buffer, mode: EnhanceMode): Promise<Buffer> {
  const normalizedMode = normalizeMode(mode);

  if (normalizedMode === "fast") {
    console.log("[Enhance] FAST: skipping final polish");
    return composedImage;
  }

  if (normalizedMode === "pro") {
    console.log("[Enhance] PRO: local polish only");
    console.log("[Enhance] PRO: no external AI used");
    console.log("[Enhance] PRO: local final polish started");
    const polishedBuffer = await localFinalPolish(composedImage);
    console.log("[Enhance] PRO: local final polish completed");
    return polishedBuffer;
  }

  console.log("[Enhance] ULTRA: SUPIR final polish started");

  try {
    const resizedBuffer = await resizeForAi(composedImage);
    const polishedBuffer = await runUltraSupirFinalPolish(resizedBuffer);
    console.log("[Enhance] ULTRA SUPIR output validation passed");
    return polishedBuffer;
  } catch (error: any) {
    console.warn("[Enhance] ULTRA SUPIR rejected, fallback to local polish:", error.message || String(error));
    console.log("[Enhance] ULTRA: fallback used if needed");
    const fallbackBuffer = await localFinalPolish(composedImage);
    return fallbackBuffer;
  }
}

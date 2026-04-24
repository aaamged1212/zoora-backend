import axios from "axios";
import sharp from "sharp";
import { ENV } from "../config/env.js";
import { runReplicate } from "./replicateHelper.js";

export type EnhanceMode = "fast" | "pro";

type EnhanceOptions = {
  mode?: EnhanceMode;
};

function normalizeMode(mode?: string): EnhanceMode {
  return mode === "pro" ? "pro" : "fast";
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

async function restoreAlpha(enhancedBuffer: Buffer, alphaSourceBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(enhancedBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    return sharp(enhancedBuffer).ensureAlpha().png().toBuffer();
  }

  const alpha = await sharp(alphaSourceBuffer)
    .ensureAlpha()
    .extractChannel("alpha")
    .resize({ width, height, fit: "fill" })
    .toBuffer();

  return sharp(enhancedBuffer).removeAlpha().joinChannel(alpha).png().toBuffer();
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

async function outputToCutoutPngBuffer(output: unknown, alphaSourceBuffer: Buffer): Promise<Buffer> {
  const outputBuffer = await replicateOutputToBuffer(output);
  const rawMeta = await sharp(outputBuffer).metadata();
  const rawChannels = rawMeta.channels || 0;
  const rawHasAlpha = rawMeta.hasAlpha === true || rawChannels >= 4;

  console.log("[Enhance] AI cutout alpha valid:", rawHasAlpha);

  if (rawChannels < 4 || !rawHasAlpha) {
    throw new Error("AI enhanced cutout lost alpha");
  }

  return restoreAlpha(outputBuffer, alphaSourceBuffer);
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

async function localSharpFallback(inputBuffer: Buffer): Promise<Buffer> {
  console.log("[Enhance] fallback to alpha-safe local enhancement");
  return sharp(inputBuffer)
    .ensureAlpha()
    .sharpen({ sigma: 1.1 })
    .modulate({ brightness: 1.04, saturation: 1.05 })
    .png()
    .toBuffer();
}

async function runFastEnhance(resizedBuffer: Buffer): Promise<Buffer> {
  const model = `nightmareai/real-esrgan:${ENV.REPLICATE_FAST_ENHANCE_VERSION}`;
  const image = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] sending to Replicate: fast");
  const output = await runReplicate(model, { image });
  const enhancedBuffer = await outputToCutoutPngBuffer(output, resizedBuffer);
  console.log("[Enhance] success: fast");
  return enhancedBuffer;
}

async function runProFinalPolish(resizedBuffer: Buffer): Promise<Buffer> {
  const model = `cjwbw/supir-v0q:${ENV.REPLICATE_SUPIR_VERSION}`;
  const image = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] sending to Replicate: pro");
  const output = await runReplicate(model, { image });
  const outputBuffer = await replicateOutputToBuffer(output);
  console.log("[Enhance] success: pro");
  return sharp(outputBuffer).png().toBuffer();
}

export async function enhanceProduct(
  imageInput: string | Buffer,
  options: EnhanceOptions = {}
): Promise<Buffer> {
  normalizeMode(options.mode);
  console.log("[Enhance] cutout enhancement mode: fast only");

  const inputBuffer = await inputToBuffer(imageInput);
  const resizedBuffer = await resizeForAi(inputBuffer);

  try {
    return await runFastEnhance(resizedBuffer);
  } catch (error: any) {
    console.warn("[Enhance] failed: fast:", error.message || String(error));
    return localSharpFallback(resizedBuffer);
  }
}

export async function enhanceImage(imageUrl: string): Promise<string> {
  const enhancedBuffer = await enhanceProduct(imageUrl, { mode: "fast" });
  return `data:image/png;base64,${enhancedBuffer.toString("base64")}`;
}

async function localFinalPolish(composedImage: Buffer): Promise<Buffer> {
  return sharp(composedImage)
    .sharpen({ sigma: 0.7 })
    .modulate({ brightness: 1.03, saturation: 1.04 })
    .png()
    .toBuffer();
}

export async function finalPolish(composedImage: Buffer, mode: EnhanceMode): Promise<Buffer> {
  if (mode !== "pro") {
    return composedImage;
  }

  console.log("[Enhance] final pro polish started");

  try {
    const resizedBuffer = await resizeForAi(composedImage);
    const polishedBuffer = await runProFinalPolish(resizedBuffer);
    console.log("[Enhance] final pro polish completed");
    return polishedBuffer;
  } catch (error: any) {
    console.warn("[Enhance] failed: final pro polish:", error.message || String(error));
    const fallbackBuffer = await localFinalPolish(composedImage);
    console.log("[Enhance] final pro polish completed");
    return fallbackBuffer;
  }
}

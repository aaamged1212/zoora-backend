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

async function outputToPngBuffer(output: unknown, alphaSourceBuffer: Buffer): Promise<Buffer> {
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
  console.log("[Enhance] using local sharp fallback");
  return sharp(inputBuffer)
    .ensureAlpha()
    .sharpen({ sigma: 1.2 })
    .modulate({ brightness: 1.05, saturation: 1.08 })
    .png()
    .toBuffer();
}

async function runFastEnhance(resizedBuffer: Buffer): Promise<Buffer> {
  const model = `nightmareai/real-esrgan:${ENV.REPLICATE_FAST_ENHANCE_VERSION}`;
  const image = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] sending to Replicate: fast");
  const output = await runReplicate(model, { image });
  const enhancedBuffer = await outputToPngBuffer(output, resizedBuffer);
  console.log("[Enhance] success: fast");
  return enhancedBuffer;
}

async function runProEnhance(resizedBuffer: Buffer): Promise<Buffer> {
  const model = `cjwbw/supir-v0q:${ENV.REPLICATE_SUPIR_VERSION}`;
  const image = `data:image/png;base64,${resizedBuffer.toString("base64")}`;

  console.log("[Enhance] sending to Replicate: pro");
  const output = await runReplicate(model, { image });
  const enhancedBuffer = await outputToPngBuffer(output, resizedBuffer);
  console.log("[Enhance] success: pro");
  return enhancedBuffer;
}

export async function enhanceProduct(
  imageInput: string | Buffer,
  options: EnhanceOptions = {}
): Promise<Buffer> {
  const mode = normalizeMode(options.mode);
  console.log(`[Enhance] mode: ${mode}`);

  const inputBuffer = await inputToBuffer(imageInput);
  const resizedBuffer = await resizeForAi(inputBuffer);

  if (mode === "pro") {
    try {
      return await runProEnhance(resizedBuffer);
    } catch (error: any) {
      console.warn("[Enhance] failed: pro:", error.message || String(error));
      console.warn("[Enhance] falling back to fast");
    }
  }

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

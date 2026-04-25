import axios from "axios";
import sharp from "sharp";

export type EnhanceMode = "fast" | "pro";

type EnhanceOptions = {
  mode?: EnhanceMode;
};

function normalizeMode(mode?: string): EnhanceMode {
  if (mode === "pro" || mode === "ultra") {
    return "pro";
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

async function enhanceCutoutLocal(inputBuffer: Buffer): Promise<Buffer> {
  console.log("[Enhance] Cutout enhancement: local alpha-safe only");
  console.log("[Enhance] AI cutout enhancement disabled");

  const enhancedBuffer = await sharp(inputBuffer)
    .ensureAlpha()
    .modulate({ brightness: 1.01, saturation: 1.01 })
    .png()
    .toBuffer();

  const metadata = await sharp(enhancedBuffer).metadata();
  console.log("[Alpha] after cutout polish channels:", metadata.channels);
  console.log("[Enhance] cutout channels after local enhancement:", metadata.channels);

  if ((metadata.channels || 0) < 4 || !metadata.hasAlpha) {
    throw new Error("Product alpha lost at stage: cutout polish");
  }

  return enhancedBuffer;
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
    .sharpen({ sigma: 0.6 })
    .modulate({ brightness: 1.015, saturation: 1.025 })
    .gamma(1.01)
    .png()
    .toBuffer();
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

  return composedImage;
}

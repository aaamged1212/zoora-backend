import sharp from "sharp";
import axios from "axios";
import { ENV } from "../config/env.js";
import { removeBackground } from "./rembg.js";
import { generateBackground, generateSafeFallbackBackground, type ProductMetrics } from "./generateBackground.js";
import { enhanceProduct, finalPolish, type EnhanceMode } from "./enhance.js";
import { analyzeBackground, composeImages } from "./compose.js";
import {
  analyzeGeneratedBackground,
} from "./productIntelligence.js";
import { generateCreativeDirection, getContrastStrategy, type DirectorProductAnalysis } from "./aiAnalyzer.js";
import { validateCreativePlan, validateFinalImage } from "./qualityGuard.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEnhanceMode(mode?: string): EnhanceMode {
  if (mode === "pro" || mode === "ultra") {
    return "pro";
  }

  return "fast";
}

export async function processJob(input: {
  image: string;
  prompt?: string;
  enhanceMode?: string;
  productCategory?: string;
  productType?: string;
  subcategory?: string;
}): Promise<Buffer> {
  console.log("[worker] Starting job pipeline...");
  let { image } = input;
  const { prompt } = input;
  const enhanceMode = normalizeEnhanceMode(input.enhanceMode);

  if (!image) {
    throw new Error("Input must contain an 'image' URL.");
  }

  console.log("[Pipeline] 1/11 Load image");
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

  console.log("[Pipeline] 2/11 Remove background");
  const cutout = await removeBackground(image);
  
  await delay(1500);

  let cutoutBuffer: Buffer;
  if (cutout.startsWith("data:")) {
    cutoutBuffer = Buffer.from(cutout.split(",")[1], "base64");
  } else {
    const res = await axios.get(cutout, { responseType: "arraybuffer" });
    cutoutBuffer = Buffer.from(res.data);
  }

  const productAnalysis = await analyzeProductForDirector(cutoutBuffer);
  const cutoutForDirectorUrl = `data:image/png;base64,${cutoutBuffer.toString("base64")}`;
  const productType = input.productType || input.productCategory || input.subcategory;

  console.log("[Pipeline] 3/11 AI Director generates creative plan");
  const rawCreativePlan = await generateCreativeDirection(cutoutForDirectorUrl, {
    productType,
    userGoal: prompt,
    productAnalysis,
  });

  console.log("[Pipeline] 4/11 Quality Guard validates creative plan");
  const creativePlan = validateCreativePlan(rawCreativePlan, {
    isSmallAccessory: isSmallAccessoryHint(productType || rawCreativePlan.product.subcategory || rawCreativePlan.product.category),
  });
  console.log("[AI Director] category:", creativePlan.product.category);
  console.log("[AI Director] background prompt:", creativePlan.scene.backgroundPrompt);
  console.log("[AI Director] scale:", creativePlan.composition.productScale);
  console.log("[AI Director] placement:", creativePlan.composition.position);
  console.log("[AI Director] shadow:", creativePlan.composition.shadowType);

  const finalEnhancedBuffer = await enhanceProduct(cutoutBuffer, { mode: enhanceMode });
  const productMetrics = await computeProductMetrics(finalEnhancedBuffer);
  const finalEnhancedCutoutUrl = `data:image/png;base64,${finalEnhancedBuffer.toString("base64")}`;

  await delay(1500);

  console.log("[Pipeline] 5/11 Generate background from AI plan");
  let bg = await generateBackground(creativePlan.scene.backgroundPrompt, {
    enhanceMode,
    negativePrompt: creativePlan.scene.negativePrompt,
    productCategory: creativePlan.product.category,
    creativePlan,
    productMetrics,
  });
  console.log("[Execution] background generated:", true);

  console.log("[Pipeline] 6/11 Analyze background geometry & apply heuristic fallback");

  bg = await ensureBackgroundGeometry({
    backgroundUrl: bg,
    productMetrics,
    creativePlan,
    enhanceMode,
    productCategory: creativePlan.product.category,
    negativePrompt: creativePlan.scene.negativePrompt,
  });

  const composedImage = await composeImages(bg, finalEnhancedCutoutUrl, {
    creativePlan,
  });
  console.log(`[Pipeline] 11/11 PRO local polish mode: ${enhanceMode}`);
  const finalImage = await finalPolish(composedImage, enhanceMode);
  const finalQuality = await validateFinalImage(finalImage, { productHadAlpha: true });

  if (!finalQuality.accepted) {
    console.warn("[Guardian] mode:", enhanceMode);
    console.warn("[Guardian] strictness:", ENV.GUARDIAN_STRICTNESS);
    console.warn("[Guardian] decision: reject");
    console.warn("[Guardian] reason:", finalQuality.reason);
    console.warn("[Guardian] retry allowed: false");
    console.warn("[Quality Guard] returning pre-polish safe composite");
    return composedImage;
  }

  console.log("[Guardian] mode:", enhanceMode);
  console.log("[Guardian] strictness:", ENV.GUARDIAN_STRICTNESS);
  console.log("[Guardian] decision: accept");
  console.log("[Guardian] reason:", finalQuality.reason);

  console.log("[worker] Final image ready.");
  return finalImage;
}

async function imageInputToBuffer(image: string): Promise<Buffer> {
  if (image.startsWith("data:")) {
    return Buffer.from(image.split(",")[1], "base64");
  }

  const res = await axios.get(image, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function analyzeProductForDirector(productBuffer: Buffer): Promise<DirectorProductAnalysis> {
  const metadata = await sharp(productBuffer).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const color = await getVisibleAverageColor(productBuffer);
  const productBrightness = (color.r + color.g + color.b) / 3;
  const dominantColorHints = inferColorHints(color);

  return {
    width,
    height,
    aspectRatio: width / height,
    productBrightness,
    dominantColorHints,
    hasAlpha: metadata.hasAlpha === true || (metadata.channels || 0) >= 4,
  };
}

function isSmallAccessoryHint(value?: string): boolean {
  return /jewelry|jewellery|ring|earring|bracelet|necklace|watch|accessory|accessories/i.test(value || "");
}

async function getVisibleAverageColor(productBuffer: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { data } = await sharp(productBuffer)
    .ensureAlpha()
    .resize({ width: 96, height: 96, fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha > 16) {
      r += data[index];
      g += data[index + 1];
      b += data[index + 2];
      count++;
    }
  }

  if (!count) {
    return { r: 128, g: 128, b: 128 };
  }

  return { r: r / count, g: g / count, b: b / count };
}

function inferColorHints(color: { r: number; g: number; b: number }): string[] {
  const brightness = (color.r + color.g + color.b) / 3;
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const saturation = max - min;

  if (brightness > 220 && saturation < 28) return ["white", "light neutral"];
  if (brightness > 188 && saturation < 35) return ["cream", "beige", "light neutral"];
  if (color.r > 165 && color.b > 130 && color.g < 170 && brightness > 120) return ["pink", "pastel"];
  if (color.r > 150 && color.g > 120 && color.b < 105) return ["champagne", "warm beige"];
  if (brightness < 70) return ["dark", "black"];
  if (color.b > color.r + 24 && color.b > color.g + 18) return ["blue", brightness < 120 ? "navy" : "cool tone"];
  if (color.r > color.g + 24 && color.r > color.b + 18) return ["red", "warm tone"];
  if (color.g > color.r + 18 && color.g > color.b + 18) return ["green", "natural tone"];
  if (saturation < 22) return ["neutral"];
  return ["balanced color"];
}

function buildContrastRegenerationInstruction(productAnalysis: DirectorProductAnalysis): string {
  const contrast = getContrastStrategy(productAnalysis.dominantColorHints || ["neutral"], productAnalysis.productBrightness);
  if ((productAnalysis.productBrightness || 0) > 160) {
    return `Create a richer, darker, more contrastive premium background that makes the light product stand out clearly, using ${contrast.palette}, without placing any product or object in the product zone.`;
  }

  if ((productAnalysis.productBrightness || 0) < 95) {
    return `Create a brighter, more luminous premium background that separates the dark product clearly, using ${contrast.palette}, without placing any product or object in the product zone.`;
  }

  return `Create stronger tonal separation and a more art-directed premium background that makes the product visually dominant, using ${contrast.palette}, without placing any product or object in the product zone.`;
}

async function ensureBackgroundGeometry(input: {
  backgroundUrl: string;
  productMetrics: ProductMetrics;
  creativePlan: ReturnType<typeof validateCreativePlan>;
  enhanceMode: EnhanceMode;
  productCategory: string;
  negativePrompt: string;
}): Promise<string> {
  const firstPass = await validateBackgroundGeometry(input.backgroundUrl, input.productMetrics, input.creativePlan);
  if (firstPass.accepted) {
    return input.backgroundUrl;
  }

  console.warn("[Guardian] mode:", input.enhanceMode);
  console.warn("[Guardian] strictness:", ENV.GUARDIAN_STRICTNESS);
  console.warn("[Guardian] decision: reject");
  console.warn("[Guardian] reason:", firstPass.reason);
  console.warn("[Guardian] retry allowed: false");
  console.log("[Guardian] using safe fallback immediately");

  return generateSafeFallbackBackground(input.productCategory, 1024, 1024);
}

async function validateBackgroundGeometry(
  backgroundUrl: string,
  productMetrics: ProductMetrics,
  creativePlan: ReturnType<typeof validateCreativePlan>
): Promise<{ accepted: boolean; reason: string }> {
  const bgBuffer = await imageInputToBuffer(backgroundUrl);
  const background = await analyzeBackground(bgBuffer);
  console.log("[BG Geometry] detected surface Y:", background.surfaceY);

  if (background.surfaceConfidence < 0.28) {
    return { accepted: false, reason: "no confident surface detected" };
  }

  if (background.surfaceY < Math.round(background.height * 0.58)) {
    return { accepted: false, reason: "surface too high vs product" };
  }

  if (background.surfaceY > Math.round(background.height * 0.92)) {
    return { accepted: false, reason: "surface too low vs product" };
  }

  const target = computeGeometryTarget(background.width, background.height, productMetrics, creativePlan.composition.productScale);
  const scaleY = target.height / Math.max(1, productMetrics.height);
  const scaledBottomOffset = Math.round(productMetrics.bottomOffset * scaleY);
  const visibleProductBottomWithinLayer = target.height - scaledBottomOffset;
  const top = Math.round(background.surfaceY - visibleProductBottomWithinLayer);
  const productBottomY = top + visibleProductBottomWithinLayer;

  if (top < 0) {
    return { accepted: false, reason: "surface alignment would crop product top" };
  }

  if (Math.abs(productBottomY - background.surfaceY) > 1) {
    return { accepted: false, reason: "product bottom does not align with surface" };
  }

  return { accepted: true, reason: "background geometry aligned" };
}

function computeGeometryTarget(
  canvasWidth: number,
  canvasHeight: number,
  productMetrics: ProductMetrics,
  requestedScale: number
): { width: number; height: number } {
  const maxHeight = Math.round(canvasHeight * 0.78);
  const maxWidth = Math.round(canvasWidth * 0.82);
  let targetHeight = Math.round(canvasHeight * Math.min(0.78, Math.max(0.55, requestedScale || 0.64)));
  let targetWidth = Math.round(targetHeight * productMetrics.aspectRatio);

  if (targetWidth > maxWidth) {
    targetWidth = maxWidth;
    targetHeight = Math.round(targetWidth / Math.max(0.01, productMetrics.aspectRatio));
  }

  if (targetHeight > maxHeight) {
    targetHeight = maxHeight;
    targetWidth = Math.round(targetHeight * productMetrics.aspectRatio);
  }

  return {
    width: targetWidth,
    height: targetHeight,
  };
}

async function computeProductMetrics(productBuffer: Buffer): Promise<ProductMetrics> {
  const image = sharp(productBuffer).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const { data } = await sharp(productBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return {
      width,
      height,
      aspectRatio: width / height,
      bottomOffset: 0,
      boundingBox: {
        left: 0,
        top: 0,
        width,
        height,
      },
    };
  }

  return {
    width,
    height,
    aspectRatio: width / height,
    bottomOffset: Math.max(0, height - 1 - maxY),
    boundingBox: {
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
}

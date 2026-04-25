import { runReplicate } from "./replicateHelper.js";
import { ENV } from "../config/env.js";
import sharp from "sharp";
import { validateGeneratedBackground } from "./productIntelligence.js";
import type { CreativeDirectionPlan } from "./aiAnalyzer.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST_EMPTY_CENTER_TERMS =
  "empty center, clean empty product placement zone, no object in the middle, no props behind the product, no bottle, no box, no container, no central pedestal object, background only, surface only, clear foreground surface, product-safe composition";
const REQUIRED_NEGATIVE_TERMS =
  "product, bottle, box, container, package, object in center, duplicate product, central object, foreground object, prop behind product, text, logo, watermark, label";
const STRICT_EMPTY_CENTER_PROMPT =
  "minimal clean studio surface, empty center placement area, no props, no objects, no product, no bottle, no container";
const STRICT_VISION_RETRY_PROMPT =
  "background only, empty commercial product staging scene, completely empty center placement area, no bottle, no product, no container, no box, no prop, no vertical object, no central object, only surface and atmosphere, product-safe empty composition";

type BackgroundMode = "fast" | "pro";

export type ProductMetrics = {
  width: number;
  height: number;
  aspectRatio: number;
  bottomOffset: number;
  boundingBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

type GenerateBackgroundOptions = {
  enhanceMode?: BackgroundMode;
  negativePrompt?: string;
  productCategory?: string;
  creativePlan?: CreativeDirectionPlan;
  productMetrics?: ProductMetrics;
};

export async function generateBackground(prompt: string, options: GenerateBackgroundOptions = {}): Promise<string> {
  console.log(`[BG] generating background for prompt: "${prompt}"...`);
  
  const cleanPrompt = prompt
    .replace(/pure black background/gi, "")
    .replace(/solid black background/gi, "")
    .trim();

  const safetyTerms = "BACKGROUND ONLY. Do not generate any product. Do not generate any bottle. Do not generate any container. Do not generate any package. clear visible surface, empty center placement area, no central object, commercial product staging environment, empty scene prepared for product compositing, clear product placement area, no product, no text, no logo, no watermark";
  const enhanceMode = options.enhanceMode === "pro" ? "pro" : "fast";
  const geometryTerms = buildGeometryPrompt(options.productMetrics, options.creativePlan);
  logProductGeometry(options.productMetrics);
  const finalPrompt = buildBackgroundPrompt(cleanPrompt, enhanceMode, safetyTerms, geometryTerms);
  const negativePrompt = options.negativePrompt
    ? `${options.negativePrompt}, ${REQUIRED_NEGATIVE_TERMS}, no product, no bottle, no container, no duplicate object, no central object, pure black background, empty black screen, flat color, underexposed, no details`
    : `${REQUIRED_NEGATIVE_TERMS}, no product, no bottle, no container, no duplicate object, no central object, pure black background, empty black screen, flat color, underexposed, no details`;
  const model = enhanceMode === "pro" ? ENV.BG_MODEL_PRO : ENV.BG_MODEL_FAST;
  const maxBgRetries = enhanceMode === "pro" ? parseMaxRetries(ENV.MAX_BG_RETRIES_PRO) : parseMaxRetries(ENV.MAX_BG_RETRIES_FAST);

  try {
    const result = await runBackgroundModel(model, enhanceMode, finalPrompt, negativePrompt);
    const quality = await validateBackgroundResult(result, options, maxBgRetries);

    if (quality.accepted) {
      return result;
    }

    if (maxBgRetries > 0) {
      console.log("[BG] regenerating with stricter empty-center prompt");
      const strictPrompt = buildBackgroundPrompt(
        cleanPrompt
          ? `${cleanPrompt}, ${STRICT_EMPTY_CENTER_PROMPT}, ${STRICT_VISION_RETRY_PROMPT}, clear horizontal surface aligned for product base placement, correct vertical alignment, no floating, no gap`
          : `${STRICT_VISION_RETRY_PROMPT}, clear horizontal surface aligned for product base placement, correct vertical alignment, no floating, no gap`,
        enhanceMode,
        safetyTerms,
        geometryTerms
      );
      try {
        const strictResult = await runBackgroundModel(model, enhanceMode, strictPrompt, negativePrompt);
        const strictQuality = await validateBackgroundResult(strictResult, options, 0);

        if (strictQuality.accepted) {
          return strictResult;
        }
      } catch (strictError: any) {
        console.error("[BG] failed:", strictError.message || String(strictError));
      }
    }

    console.log("[BG] using safe fallback background prompt");
    return await generateSafeFallbackBackground(options.productCategory || options.creativePlan?.product.category || "generic", 1024, 1024);
  } catch (error: any) {
    console.error("[BG] failed:", error.message);

    if (model !== ENV.BG_MODEL_FAST) {
      console.log("[BG] fallback to FAST model");

      try {
        const fastFallbackResult = await runBackgroundModel(
          ENV.BG_MODEL_FAST,
          "fast",
          buildBackgroundPrompt(cleanPrompt, "fast", safetyTerms, geometryTerms),
          negativePrompt
        );
        const fastFallbackQuality = await validateBackgroundResult(fastFallbackResult, options, 0);
        if (fastFallbackQuality.accepted) {
          return fastFallbackResult;
        }
      } catch (fallbackError: any) {
        console.error("[BG] failed:", fallbackError.message);
      }
    }

    console.log("[BG] using safe fallback background prompt");
    return await generateSafeFallbackBackground(options.productCategory || options.creativePlan?.product.category || "generic", 1024, 1024);
  }
}

function buildBackgroundPrompt(
  cleanPrompt: string,
  enhanceMode: BackgroundMode,
  safetyTerms: string,
  geometryTerms: string
): string {
  const basePrompt = cleanPrompt || "premium commercial product advertising background";
  return enhanceMode === "fast"
    ? `${basePrompt}, ${geometryTerms}, ${safetyTerms}, ${FAST_EMPTY_CENTER_TERMS}`
    : `${basePrompt}, ${geometryTerms}, ${safetyTerms}`;
}

function buildGeometryPrompt(productMetrics?: ProductMetrics, creativePlan?: CreativeDirectionPlan): string {
  if (!productMetrics) {
    return "design background with clear visible surface aligned to the uploaded product base, no floating composition, the surface or pedestal must be placed exactly where the product bottom will touch";
  }

  const heightRatio = creativePlan?.composition.productScale || 0.64;
  const visibleCutoutRatio = productMetrics.boundingBox.height / Math.max(1, productMetrics.height);
  const bottomOffsetRatio = productMetrics.bottomOffset / Math.max(1, productMetrics.height);
  return `design background for a product with final height ratio ${heightRatio.toFixed(2)} and vertical center composition, visible cutout height ratio ${visibleCutoutRatio.toFixed(2)}, ensure a visible surface aligned to product base level, pedestal height must match product grounding, no floating composition, product transparent bottom offset ratio ${bottomOffsetRatio.toFixed(3)}, the surface or pedestal must be placed exactly where the product bottom will touch, leave correct vertical alignment for grounding`;
}

function logProductGeometry(productMetrics?: ProductMetrics): void {
  if (!productMetrics) {
    return;
  }

  console.log("[BG Geometry] product height:", productMetrics.height);
  console.log("[BG Geometry] product bottom offset:", productMetrics.bottomOffset);
  console.log("[BG Geometry] expected surface alignment:", "product_bottom_Y = surface_Y");
}

async function validateBackgroundResult(resultUrl: string, options: GenerateBackgroundOptions, maxRetries: number) {
  console.log(`[Guardian] mode: ${options.enhanceMode || "fast"}`);
  console.log(`[Guardian] strictness: ${ENV.GUARDIAN_STRICTNESS}`);

  if (options.enhanceMode !== "pro") {
    console.log("[Guardian] decision: accept");
    console.log("[Guardian] reason: heuristic validation only in fast mode");
    console.log(`[Guardian] retry allowed: ${maxRetries > 0}`);
    return { accepted: true, reason: "fast mode heuristics", centerZoneEmpty: true, hasProductLikeObject: false, hasCentralObject: false, recommendedAction: "none" };
  }

  try {
    const result = await validateGeneratedBackground(resultUrl, options.productCategory, options.creativePlan);
    console.log(`[Guardian] decision: ${result.accepted ? "accept" : "reject"}`);
    console.log(`[Guardian] reason: ${result.reason}`);
    console.log(`[Guardian] retry allowed: ${!result.accepted && maxRetries > 0}`);
    return result;
  } catch (error: any) {
    console.warn("[Guardian] decision: reject");
    console.warn(`[Guardian] reason: validation failed - ${error.message || String(error)}`);
    console.warn(`[Guardian] retry allowed: ${maxRetries > 0}`);
    return {
      accepted: false,
      reason: "background validation failed",
      centerZoneEmpty: false,
      hasProductLikeObject: false,
      hasCentralObject: true,
      recommendedAction: "fallback" as const,
    };
  }
}

function parseMaxRetries(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

export async function generateSafeFallbackBackground(category: string, width: number, height: number): Promise<string> {
  const palette = fallbackPaletteForCategory(category);
  const surfaceY = Math.round(height * 0.84);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.wallStart}"/>
      <stop offset="55%" stop-color="${palette.wallMid}"/>
      <stop offset="100%" stop-color="${palette.wallEnd}"/>
    </linearGradient>
    <linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${palette.surfaceTop}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${palette.surfaceBottom}" stop-opacity="1"/>
    </linearGradient>
    <radialGradient id="light" cx="50%" cy="30%" r="62%">
      <stop offset="0%" stop-color="${palette.light}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${palette.light}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wall)"/>
  <rect width="${width}" height="${height}" fill="url(#light)"/>
  <rect x="0" y="${surfaceY}" width="${width}" height="${height - surfaceY}" fill="url(#surface)"/>
  <line x1="0" y1="${surfaceY}" x2="${width}" y2="${surfaceY}" stroke="${palette.surfaceLine}" stroke-opacity="0.22" stroke-width="2"/>
</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function fallbackPaletteForCategory(category: string) {
  const text = category.toLowerCase();
  if (/tech|electronic|gadget|device/.test(text)) {
    return {
      wallStart: "#07111f",
      wallMid: "#101a33",
      wallEnd: "#1e2c4a",
      surfaceTop: "#18233a",
      surfaceBottom: "#09101d",
      surfaceLine: "#7aa5ff",
      light: "#7aa5ff",
    };
  }
  if (/perfume|jewelry|luxury|cosmetic|skincare/.test(text)) {
    return {
      wallStart: "#2b0717",
      wallMid: "#5b1837",
      wallEnd: "#c7a46a",
      surfaceTop: "#7c5d52",
      surfaceBottom: "#261018",
      surfaceLine: "#f3d28c",
      light: "#f3d28c",
    };
  }
  return {
    wallStart: "#e9e7e2",
    wallMid: "#d6d0c7",
    wallEnd: "#b9b1a8",
    surfaceTop: "#d8d3cb",
    surfaceBottom: "#a99f94",
    surfaceLine: "#ffffff",
    light: "#ffffff",
  };
}

async function runBackgroundModel(
  model: string,
  enhanceMode: BackgroundMode,
  prompt: string,
  negativePrompt: string
): Promise<string> {
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      console.log("[BG] sending request...");
      console.log("[BG] model:", model);
      console.log("[BG] mode:", enhanceMode);
      console.log("[BG] prompt:", prompt);

      const output = await runReplicate(model, {
        prompt,
        negative_prompt: negativePrompt,
        width: 1024,
        height: 1024,
      });

      console.log("[BG] raw output:", output);

      const resultUrl = Array.isArray(output) ? output[0] : output;

      if (!resultUrl || typeof resultUrl !== "string") {
        throw new Error("Background generation failed: invalid output");
      }

      console.log("[BG] final URL:", resultUrl);
      return resultUrl;
    } catch (error: any) {
      attempt++;

      if (attempt >= maxAttempts) {
        throw error;
      }

      const waitTime = Math.pow(2, attempt) * 1000;
      await delay(waitTime);
    }
  }

  throw new Error("Background generation failed");
}

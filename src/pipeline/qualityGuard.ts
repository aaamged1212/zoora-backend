import sharp from "sharp";
import type { CreativeDirectionPlan } from "./aiAnalyzer.js";

export type QualityResult = {
  accepted: boolean;
  reason: string;
};

export type CreativePlanContext = {
  productAreaRatio?: number;
  isSmallAccessory?: boolean;
};

export type FinalImageValidationContext = {
  productAreaRatio?: number;
  productHadAlpha?: boolean;
  productBrightness?: number;
  backgroundBrightness?: number;
  productScale?: number;
  surfaceTouchValid?: boolean;
};

const FALLBACK_BACKGROUND_PROMPT =
  "premium product advertising background, clear visible surface, empty center placement area, no central object, commercial product staging environment, clear product placement area, no product, no bottle, no container, no duplicate object, no text, no logo, professional commercial product photography";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function cleanString(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function backgroundPromptIsWeak(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return wordCount(prompt) < 45
    || normalized.includes("soft pastel gradient")
    || normalized.includes("clean background")
    || normalized.includes("minimal studio")
    || normalized.includes("plain background")
    || normalized.split(",").length < 5;
}

function expandWeakBackgroundPrompt(plan: CreativeDirectionPlan): string {
  const colors = plan.product.dominantColors.length ? plan.product.dominantColors.join(", ") : "the product colors";
  const palette = plan.scene.colorPalette.length
    ? plan.scene.colorPalette.join(", ")
    : "rich contrasting tones, refined neutrals, and controlled accent colors";

  return `premium ${plan.product.category || "commercial"} product advertising background for ${plan.product.subcategory || "the product"}, designed to make ${colors} stand out clearly, using ${palette}, cinematic ecommerce art direction with a clear visible surface or pedestal top in the lower center, commercial product staging environment, dimensional environment depth, controlled directional lighting from above and behind, atmospheric highlights, elegant negative space for future ad text, empty center placement area reserved for the product, no central object, high-end commercial product photography, no product, no bottle, no container, no duplicate object, no text, no logo, no watermark`;
}

function normalizeCategory(value: string): string {
  const normalized = value.toLowerCase().trim();
  if (!normalized || normalized.length > 48 || !/^[a-z0-9 &/+-]+$/.test(normalized)) {
    return "generic";
  }

  return normalized;
}

function isSmallAccessory(plan: CreativeDirectionPlan, context: CreativePlanContext): boolean {
  const category = plan.product.category.toLowerCase();
  const subcategory = plan.product.subcategory.toLowerCase();
  return context.isSmallAccessory === true
    || /jewelry|jewellery|ring|earring|bracelet|necklace|watch|accessory|accessories/.test(`${category} ${subcategory}`);
}

export function validateCreativePlan(
  plan: CreativeDirectionPlan,
  context: CreativePlanContext = {}
): CreativeDirectionPlan {
  let changed = false;
  const next: CreativeDirectionPlan = {
    product: { ...plan.product, dominantColors: [...plan.product.dominantColors] },
    scene: { ...plan.scene, colorPalette: [...plan.scene.colorPalette] },
    composition: { ...plan.composition },
  };

  const originalCategory = next.product.category;
  next.product.category = normalizeCategory(next.product.category);
  changed ||= next.product.category !== originalCategory;

  const originalPrompt = next.scene.backgroundPrompt;
  next.scene.backgroundPrompt = cleanString(next.scene.backgroundPrompt, FALLBACK_BACKGROUND_PROMPT);
  if (backgroundPromptIsWeak(next.scene.backgroundPrompt)) {
    next.scene.backgroundPrompt = expandWeakBackgroundPrompt(next);
  }
  changed ||= next.scene.backgroundPrompt !== originalPrompt;

  const originalScale = next.composition.productScale;
  let productScale = clamp(finiteNumber(next.composition.productScale, 0.64), 0.55, 0.78);
  if (productScale < 0.6 && !isSmallAccessory(next, context)) {
    productScale = 0.62;
  }
  next.composition.productScale = productScale;
  changed ||= next.composition.productScale !== originalScale;

  const originalShadowIntensity = next.composition.shadowIntensity;
  next.composition.shadowIntensity = 0;
  changed ||= next.composition.shadowIntensity !== originalShadowIntensity;

  const originalShadowBlur = next.composition.shadowBlur;
  next.composition.shadowBlur = 0;
  changed ||= next.composition.shadowBlur !== originalShadowBlur;

  if (next.composition.shadowType !== "none") {
    changed = true;
  }
  next.composition.shadowType = "none";

  if (next.composition.surfaceAlignment !== "sit-on-surface") {
    next.composition.surfaceAlignment = "sit-on-surface";
    changed = true;
  }

  if (next.composition.reflectionAllowed) {
    changed = true;
  }
  next.composition.reflectionAllowed = false;

  console.log("[Quality Guard] plan normalized:", changed);
  return next;
}

export async function validateFinalImage(
  finalBuffer: Buffer,
  context: FinalImageValidationContext = {}
): Promise<QualityResult> {
  try {
    const metadata = await sharp(finalBuffer).metadata();
    if (!metadata.width || !metadata.height || finalBuffer.length < 1024) {
      return { accepted: false, reason: "invalid output image" };
    }

    if (context.productHadAlpha === false) {
      return { accepted: false, reason: "product alpha lost before final compose" };
    }

    if (typeof context.productAreaRatio === "number" && context.productAreaRatio < 0.08) {
      return { accepted: false, reason: "product appears too small" };
    }

    if (typeof context.productScale === "number" && context.productScale < 0.55) {
      return { accepted: false, reason: "product scale below physics minimum" };
    }

    if (context.surfaceTouchValid === false) {
      return { accepted: false, reason: "product is not grounded on surface" };
    }

    const stats = await sharp(finalBuffer).stats();
    const rgb = stats.channels.slice(0, 3);
    const brightness = rgb.reduce((sum, channel) => sum + channel.mean, 0) / rgb.length;

    if (brightness > 242) {
      return { accepted: false, reason: "mostly white or overexposed" };
    }

    if (brightness < 12) {
      return { accepted: false, reason: "mostly black" };
    }

    if (
      typeof context.productBrightness === "number"
      && typeof context.backgroundBrightness === "number"
      && Math.abs(context.productBrightness - context.backgroundBrightness) < 18
    ) {
      return { accepted: false, reason: "product blends into background" };
    }

    const thumbnail = await sharp(finalBuffer)
      .resize({ width: 64, height: 64, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    let nearBlackPixels = 0;

    for (let index = 0; index < thumbnail.length; index += 3) {
      if (thumbnail[index] < 6 && thumbnail[index + 1] < 6 && thumbnail[index + 2] < 6) {
        nearBlackPixels++;
      }
    }

    if (nearBlackPixels / (thumbnail.length / 3) > 0.75 && brightness < 42) {
      return { accepted: false, reason: "possible black rectangle or black field detected" };
    }

    return { accepted: true, reason: "final image safe" };
  } catch (error: any) {
    return { accepted: false, reason: error.message || String(error) };
  }
}

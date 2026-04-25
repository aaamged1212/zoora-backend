import axios from "axios";
import { ENV } from "../config/env.js";

export type CreativeDirectionPlan = {
  product: {
    category: string;
    subcategory: string;
    description: string;
    material: string;
    dominantColors: string[];
    shape: "tall" | "wide" | "compact" | "flat" | "irregular";
  };
  scene: {
    concept: string;
    backgroundPrompt: string;
    negativePrompt: string;
    environmentType: string;
    surfaceType: string;
    colorPalette: string[];
    lightingMood: string;
    cameraPerspective: string;
    extraElementsAllowed: boolean;
    extraElementsDescription: string;
    negativeSpace: "top" | "left" | "right" | "balanced";
  };
  composition: {
    productScale: number;
    position: "lower-center" | "center" | "left-hero" | "right-hero" | "pedestal-center";
    surfaceAlignment: "sit-on-surface" | "floating-hero" | "flat-lay";
    shadowType: "none" | "subtle-contact" | "soft-grounded" | "premium-studio";
    shadowIntensity: number;
    shadowBlur: number;
    reflectionAllowed: boolean;
  };
};

export type DirectorProductAnalysis = {
  width?: number;
  height?: number;
  aspectRatio?: number;
  productBrightness?: number;
  dominantColorHints?: string[];
  hasAlpha?: boolean;
};

type CreativeDirectionInput = {
  userGoal?: string;
  productType?: string;
  productAnalysis?: DirectorProductAnalysis;
};

const SYSTEM_PROMPT = `You are a world-class commercial advertising art director for premium ecommerce product imagery.

Your job is to create a complete creative direction plan for an AI product advertisement.

You must think like:
- luxury brand art director
- ecommerce conversion designer
- product photographer
- color stylist
- creative director

Do NOT create plain, generic, or minimal prompts unless the product truly requires that.

You must analyze:
1. product category
2. product shape
3. product dominant colors
4. product material
5. visual contrast needs
6. best background mood
7. best color palette to make the product stand out
8. appropriate environment
9. appropriate surface/pedestal/stand
10. lighting direction and mood
11. negative space for future ad text

IMPORTANT COLOR RULE:
If the product is light, pastel, white, beige, pink, or low-contrast, choose a darker or richer background so the product stands out.
If the product is dark, choose a brighter or more luminous background.
Do not use a background that makes the product disappear.

IMPORTANT REALITY RULE:
The background must be an empty commercial staging environment prepared for the real extracted product cutout.
Never include the product, a bottle, a container, a duplicate hero object, or any central object that could look like the product.
The product must have a physically believable place to sit.
Prefer a clear visible surface, pedestal top, tabletop, marble slab, plinth, counter, or floor contact zone.
The product should be grounded by scene design, not by fake shadow effects.

IMPORTANT PROMPT QUALITY RULE:
backgroundPrompt must be detailed, cinematic, and commercially useful.
It must be at least 45 words.
It must include:
- environment description
- surface or pedestal description if appropriate
- color palette
- lighting direction
- depth and atmosphere
- clear visible surface
- empty product placement zone
- empty center placement area
- no central object
- commercial product staging environment
- commercial photography style
- no product, no text, no logo, no watermark

Avoid weak prompts like:
'soft pastel gradient'
'clean background'
'minimal studio'

For a pink perfume bottle, a good direction could be:
luxury editorial perfume advertising scene with deep burgundy, champagne gold, and soft warm beige tones, elegant marble or glass display surface, subtle golden rim lighting from above and behind, premium boutique atmosphere, shallow depth of field, refined reflections on the surface, empty center placement area reserved for the product, high-end commercial product photography, no product, no text, no logo, no watermark.

Return strict JSON only.`;

function fallbackCreativeDirection(input: CreativeDirectionInput = {}): CreativeDirectionPlan {
  const productType = input.productType || "generic product";
  const colors = input.productAnalysis?.dominantColorHints?.length
    ? input.productAnalysis.dominantColorHints
    : ["neutral"];
  const contrast = getContrastStrategy(colors, input.productAnalysis?.productBrightness);

  return {
    product: {
      category: "generic",
      subcategory: productType,
      description: productType,
      material: "commercial product packaging",
      dominantColors: colors,
      shape: inferShape(input.productAnalysis),
    },
    scene: {
      concept: "premium commercial product advertisement with strong product contrast",
      backgroundPrompt: expandBackgroundPrompt({
        productType,
        category: "generic",
        material: "commercial product packaging",
        colors,
        contrastPalette: contrast.palette,
        userGoal: input.userGoal,
      }),
      negativePrompt: "product, bottle, container, duplicate object, central object, object in center, centered prop, text, logo, watermark, crowded scene, hands, people, black rectangle, black blob",
      environmentType: "premium studio",
      surfaceType: "refined display surface",
      colorPalette: contrast.palette.split(",").map((value) => value.trim()),
      lightingMood: "premium directional advertising light",
      cameraPerspective: "straight-on product advertising perspective",
      extraElementsAllowed: true,
      extraElementsDescription: "subtle commercial styling elements kept around the edges only",
      negativeSpace: "top",
    },
    composition: {
      productScale: 0.64,
      position: "lower-center",
      surfaceAlignment: "sit-on-surface",
      shadowType: "none",
      shadowIntensity: 0,
      shadowBlur: 0,
      reflectionAllowed: false,
    },
  };
}

function inferShape(productAnalysis?: DirectorProductAnalysis): CreativeDirectionPlan["product"]["shape"] {
  const aspectRatio = productAnalysis?.aspectRatio;
  if (!Number.isFinite(aspectRatio)) return "compact";
  if ((aspectRatio || 1) < 0.65) return "tall";
  if ((aspectRatio || 1) > 1.45) return "wide";
  return "compact";
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function promptIsTooGeneric(prompt: string): boolean {
  const normalized = prompt.toLowerCase().trim();
  const weakPhrases = [
    "soft pastel gradient",
    "clean background",
    "minimal studio",
    "simple background",
    "plain background",
    "gradient background",
  ];

  return wordCount(prompt) < 45
    || weakPhrases.some((phrase) => normalized.includes(phrase))
    || normalized.split(",").length < 5;
}

export function getContrastStrategy(colors: string[], brightness?: number) {
  const colorText = colors.join(" ").toLowerCase();
  const lightProduct = /pink|white|beige|cream|silver|pastel|peach|ivory|rose|blush|champagne/.test(colorText)
    || (typeof brightness === "number" && brightness > 178);
  const darkProduct = /black|navy|charcoal|brown|espresso|dark|graphite|deep/.test(colorText)
    || (typeof brightness === "number" && brightness < 85);

  if (lightProduct) {
    return {
      strategy: "light product needs richer dark contrast",
      palette: "deep burgundy, deep plum, charcoal, midnight navy, champagne gold accents, warm marble highlights",
    };
  }

  if (darkProduct) {
    return {
      strategy: "dark product needs luminous premium contrast",
      palette: "soft cream, ivory marble, warm spotlight, pale stone, luminous champagne, gentle atmospheric glow",
    };
  }

  return {
    strategy: "balanced product needs premium tonal separation",
    palette: "layered complementary tones, controlled contrast, refined neutral surface, selective metallic accents",
  };
}

function expandBackgroundPrompt(input: {
  productType: string;
  category: string;
  material: string;
  colors: string[];
  contrastPalette: string;
  userGoal?: string;
}): string {
  const colorText = input.colors.length ? input.colors.join(", ") : "the product colors";
  const userGoal = input.userGoal ? `, aligned with this creative goal: ${input.userGoal}` : "";

  return `premium ${input.category} product advertisement background for a ${input.productType}, designed to contrast clearly with ${colorText} ${input.material}, using ${input.contrastPalette}, art-directed luxury ecommerce scene with a clear visible surface or pedestal top in the lower center, commercial product staging environment, dimensional environment depth, controlled directional lighting from above and slightly behind, atmospheric highlights, elegant negative space for future ad text, empty center placement area reserved for the product, no central object, high-end commercial product photography${userGoal}, no product, no bottle, no container, no duplicate object, no text, no logo, no watermark`;
}

function normalizeAiPlanShape(raw: any, fallback: CreativeDirectionPlan): CreativeDirectionPlan {
  const product = raw?.product || {};
  const scene = raw?.scene || {};
  const composition = raw?.composition || {};

  return {
    product: {
      category: pickString(product.category, fallback.product.category),
      subcategory: pickString(product.subcategory, fallback.product.subcategory),
      description: pickString(product.description, fallback.product.description),
      material: pickString(product.material, fallback.product.material),
      dominantColors: pickStringArray(product.dominantColors, fallback.product.dominantColors),
      shape: pickEnum(product.shape, ["tall", "wide", "compact", "flat", "irregular"] as const, fallback.product.shape),
    },
    scene: {
      concept: pickString(scene.concept, fallback.scene.concept),
      backgroundPrompt: pickString(scene.backgroundPrompt, fallback.scene.backgroundPrompt),
      negativePrompt: pickString(scene.negativePrompt, fallback.scene.negativePrompt),
      environmentType: pickString(scene.environmentType, fallback.scene.environmentType),
      surfaceType: pickString(scene.surfaceType, fallback.scene.surfaceType),
      colorPalette: pickStringArray(scene.colorPalette, fallback.scene.colorPalette),
      lightingMood: pickString(scene.lightingMood, fallback.scene.lightingMood),
      cameraPerspective: pickString(scene.cameraPerspective, fallback.scene.cameraPerspective),
      extraElementsAllowed: pickBoolean(scene.extraElementsAllowed, fallback.scene.extraElementsAllowed),
      extraElementsDescription: pickString(scene.extraElementsDescription, fallback.scene.extraElementsDescription),
      negativeSpace: pickEnum(scene.negativeSpace, ["top", "left", "right", "balanced"] as const, fallback.scene.negativeSpace),
    },
    composition: {
      productScale: pickNumber(composition.productScale, fallback.composition.productScale),
      position: pickEnum(composition.position, ["lower-center", "center", "left-hero", "right-hero", "pedestal-center"] as const, fallback.composition.position),
      surfaceAlignment: pickEnum(composition.surfaceAlignment, ["sit-on-surface", "floating-hero", "flat-lay"] as const, fallback.composition.surfaceAlignment),
      shadowType: pickEnum(composition.shadowType, ["none", "subtle-contact", "soft-grounded", "premium-studio"] as const, fallback.composition.shadowType),
      shadowIntensity: pickNumber(composition.shadowIntensity, fallback.composition.shadowIntensity),
      shadowBlur: pickNumber(composition.shadowBlur, fallback.composition.shadowBlur),
      reflectionAllowed: false,
    },
  };
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function ensurePromptQuality(plan: CreativeDirectionPlan, input: CreativeDirectionInput): CreativeDirectionPlan {
  const next: CreativeDirectionPlan = {
    product: { ...plan.product, dominantColors: [...plan.product.dominantColors] },
    scene: { ...plan.scene, colorPalette: [...plan.scene.colorPalette] },
    composition: { ...plan.composition },
  };

  if (!promptIsTooGeneric(next.scene.backgroundPrompt)) {
    return next;
  }

  const contrast = getContrastStrategy(next.product.dominantColors, input.productAnalysis?.productBrightness);
  console.warn("[AI Director] background prompt rejected: too short or generic");
  next.scene.backgroundPrompt = expandBackgroundPrompt({
    productType: next.product.subcategory || input.productType || "product",
    category: next.product.category || "commercial",
    material: next.product.material || "premium product material",
    colors: next.product.dominantColors,
    contrastPalette: contrast.palette,
    userGoal: input.userGoal,
  });
  next.scene.colorPalette = contrast.palette.split(",").map((value) => value.trim());
  return next;
}

async function requestCreativePlan(
  productImage: string,
  input: CreativeDirectionInput,
  fallback: CreativeDirectionPlan,
  stricterPromptInstruction?: string
): Promise<CreativeDirectionPlan> {
  const contrast = getContrastStrategy(input.productAnalysis?.dominantColorHints || fallback.product.dominantColors, input.productAnalysis?.productBrightness);
  const userContext = [
    input.productType ? `User-provided product type: ${input.productType}` : "",
    input.userGoal ? `User goal: ${input.userGoal}` : "",
    input.productAnalysis ? `Measured product analysis: ${JSON.stringify(input.productAnalysis)}` : "",
    `Contrast strategy: ${contrast.strategy}. Recommended background contrast palette: ${contrast.palette}.`,
    stricterPromptInstruction || "",
    "Return only the strict JSON object with the requested keys.",
  ].filter(Boolean).join("\n");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${userContext}

Required JSON shape:
{
  "product": {
    "category": "",
    "subcategory": "",
    "description": "",
    "material": "",
    "dominantColors": [],
    "shape": "tall | wide | compact | flat | irregular"
  },
  "scene": {
    "concept": "",
    "backgroundPrompt": "",
    "negativePrompt": "",
    "environmentType": "",
    "surfaceType": "",
    "colorPalette": [],
    "lightingMood": "",
    "cameraPerspective": "",
    "extraElementsAllowed": true,
    "extraElementsDescription": "",
    "negativeSpace": "top | left | right | balanced"
  },
  "composition": {
    "productScale": 0.65,
    "position": "lower-center | center | left-hero | right-hero | pedestal-center",
    "surfaceAlignment": "sit-on-surface | floating-hero | flat-lay",
    "shadowType": "none | subtle-contact | soft-grounded | premium-studio",
    "shadowIntensity": 0.12,
    "shadowBlur": 28,
    "reflectionAllowed": false
  }
}`
            },
            { type: "image_url", image_url: { url: productImage } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1300,
    },
    {
      headers: {
        Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI returned empty creative direction");
  }

  return normalizeAiPlanShape(JSON.parse(stripCodeFence(content)), fallback);
}

export async function generateCreativeDirection(
  productImage: string,
  input: CreativeDirectionInput = {}
): Promise<CreativeDirectionPlan> {
  console.log("[AI Director] analyzing product image");
  const fallback = fallbackCreativeDirection(input);

  if (!ENV.OPENAI_API_KEY) {
    console.warn("[AI Director] OPENAI_API_KEY missing, using fallback creative direction");
    const plan = ensurePromptQuality(fallback, input);
    const contrast = getContrastStrategy(plan.product.dominantColors, input.productAnalysis?.productBrightness);
    console.log("[AI Director] contrast strategy:", contrast.strategy);
    console.log("[AI Director] product colors:", plan.product.dominantColors.join(", "));
    console.log("[AI Director] background contrast palette:", contrast.palette);
    console.log("[AI Director] creative plan created");
    return plan;
  }

  try {
    let plan = await requestCreativePlan(productImage, input, fallback);

    if (promptIsTooGeneric(plan.scene.backgroundPrompt)) {
      plan = await requestCreativePlan(
        productImage,
        input,
        fallback,
        "The previous backgroundPrompt was too short or generic. Regenerate with at least 45 words, strong product color contrast, luxury commercial art direction, environment detail, surface detail, lighting direction, depth, atmosphere, and an empty product placement zone."
      );
    }

    plan = ensurePromptQuality(plan, input);
    const contrast = getContrastStrategy(plan.product.dominantColors, input.productAnalysis?.productBrightness);
    console.log("[AI Director] contrast strategy:", contrast.strategy);
    console.log("[AI Director] product colors:", plan.product.dominantColors.join(", "));
    console.log("[AI Director] background contrast palette:", contrast.palette);
    console.log("[AI Director] creative plan created");
    return plan;
  } catch (error: any) {
    const message = error.response?.data ? JSON.stringify(error.response.data) : error.message || String(error);
    console.warn("[AI Director] analysis failed, using fallback creative direction:", message);
    const plan = ensurePromptQuality(fallback, input);
    const contrast = getContrastStrategy(plan.product.dominantColors, input.productAnalysis?.productBrightness);
    console.log("[AI Director] contrast strategy:", contrast.strategy);
    console.log("[AI Director] product colors:", plan.product.dominantColors.join(", "));
    console.log("[AI Director] background contrast palette:", contrast.palette);
    console.log("[AI Director] creative plan created");
    return plan;
  }
}

export async function analyzeProductWithAI(image: string): Promise<CreativeDirectionPlan> {
  return generateCreativeDirection(image);
}

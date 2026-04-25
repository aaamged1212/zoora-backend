import sharp from "sharp";
import axios from "axios";
import { ENV } from "../config/env.js";
import type { CreativeDirectionPlan } from "./aiAnalyzer.js";

export type BackgroundSuitability = {
  accepted: boolean;
  reason: string;
  overallBrightness: number;
  centerBrightness: number;
  centerContrast: number;
};

export type BackgroundVisionValidation = {
  accepted: boolean;
  reason: string;
  centerZoneEmpty: boolean;
  hasProductLikeObject: boolean;
  hasCentralObject: boolean;
  recommendedAction: "accept" | "regenerate" | "fallback";
};

export async function validateBackgroundPlacementZone(backgroundBuffer: Buffer): Promise<BackgroundSuitability> {
  const metadata = await sharp(backgroundBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const overallStats = await sharp(backgroundBuffer).stats();
  const overallBrightness = overallStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const centerBuffer = await sharp(backgroundBuffer)
    .extract({
      left: Math.round(width * 0.3),
      top: Math.round(height * 0.25),
      width: Math.max(1, Math.round(width * 0.4)),
      height: Math.max(1, Math.round(height * 0.5)),
    })
    .png()
    .toBuffer();
  const centerStats = await sharp(centerBuffer).stats();
  const centerContrast = centerStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / 3;
  const centerBrightness = centerStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const edgeBuffer = await sharp(centerBuffer)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
    })
    .raw()
    .toBuffer();
  const edgeValues = Array.from(edgeBuffer);
  const edgeMean = edgeValues.reduce((sum, value) => sum + value, 0) / Math.max(1, edgeValues.length);
  const strongEdgeRatio = edgeValues.filter((value) => value > 42).length / Math.max(1, edgeValues.length);
  const centerHasObjectLikeDetail = (centerContrast > 52 && edgeMean > 10)
    || edgeMean > 19
    || strongEdgeRatio > 0.16;
  const centerHasStrongBrightnessObject = Math.abs(centerBrightness - overallBrightness) > 46 && centerContrast > 38;
  const accepted = !centerHasObjectLikeDetail && !centerHasStrongBrightnessObject;

  console.log("[BG Quality] center zone empty:", accepted);
  if (!accepted) {
    console.warn("[BG Quality] rejected: center placement zone not empty");
  }

  return {
    accepted,
    reason: accepted ? "background suitable" : "center placement zone not empty",
    overallBrightness,
    centerBrightness,
    centerContrast,
  };
}

export async function validateGeneratedBackground(
  backgroundInput: string | Buffer,
  productCategory?: string,
  creativePlan?: CreativeDirectionPlan
): Promise<BackgroundVisionValidation> {
  const backgroundBuffer = Buffer.isBuffer(backgroundInput)
    ? backgroundInput
    : await imageInputToBuffer(backgroundInput);
  const heuristic = await validateBackgroundPlacementZone(backgroundBuffer);

  if (!ENV.OPENAI_API_KEY) {
    return {
      accepted: heuristic.accepted,
      reason: heuristic.reason,
      centerZoneEmpty: heuristic.accepted,
      hasProductLikeObject: false,
      hasCentralObject: !heuristic.accepted,
      recommendedAction: heuristic.accepted ? "accept" : "regenerate",
    };
  }

  try {
    const aiValidation = await validateBackgroundWithVision(backgroundBuffer, productCategory, creativePlan);
    const accepted = heuristic.accepted
      && aiValidation.accepted
      && aiValidation.centerZoneEmpty
      && !aiValidation.hasProductLikeObject
      && !aiValidation.hasCentralObject;

    return {
      ...aiValidation,
      accepted,
      reason: accepted
        ? aiValidation.reason || "background accepted"
        : aiValidation.reason || heuristic.reason || "center placement area is not clean",
      centerZoneEmpty: heuristic.accepted && aiValidation.centerZoneEmpty,
      hasCentralObject: aiValidation.hasCentralObject || !heuristic.accepted,
      recommendedAction: accepted
        ? "accept"
        : aiValidation.recommendedAction === "fallback"
          ? "fallback"
          : "regenerate",
    };
  } catch (error: any) {
    console.warn("[BG Vision] validation failed, using heuristic result:", error.message || String(error));
    return {
      accepted: heuristic.accepted,
      reason: heuristic.reason,
      centerZoneEmpty: heuristic.accepted,
      hasProductLikeObject: false,
      hasCentralObject: !heuristic.accepted,
      recommendedAction: heuristic.accepted ? "accept" : "regenerate",
    };
  }
}

async function validateBackgroundWithVision(
  backgroundBuffer: Buffer,
  productCategory?: string,
  creativePlan?: CreativeDirectionPlan
): Promise<BackgroundVisionValidation> {
  const pngBuffer = await sharp(backgroundBuffer)
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const imageUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const productContext = [
    productCategory ? `Product category: ${productCategory}.` : "",
    creativePlan?.product?.subcategory ? `Product subcategory: ${creativePlan.product.subcategory}.` : "",
    creativePlan?.scene?.surfaceType ? `Intended surface: ${creativePlan.scene.surfaceType}.` : "",
  ].filter(Boolean).join(" ");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a strict background quality inspector for product compositing. Return strict JSON only.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this generated background for a product compositing system.
The center area must be empty and reserved for placing the uploaded product.
${productContext}

Reject the background if it contains:
- bottle
- product
- container
- package
- box
- object in center
- duplicate product
- vertical object under placement area
- stand that looks like another product
- anything occupying the product placement zone

Allowed:
- floor
- wall
- horizontal surface
- abstract lighting
- marble texture
- empty pedestal/platform ONLY if it is clearly horizontal and does not look like a product.

Return strict JSON:
{
  "accepted": true,
  "reason": "",
  "centerZoneEmpty": true,
  "hasProductLikeObject": false,
  "hasCentralObject": false,
  "recommendedAction": "accept"
}`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 450,
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
    throw new Error("OpenAI returned empty background validation");
  }
  const parsed = JSON.parse(stripCodeFence(content));

  return {
    accepted: parsed.accepted === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    centerZoneEmpty: parsed.centerZoneEmpty === true,
    hasProductLikeObject: parsed.hasProductLikeObject === true,
    hasCentralObject: parsed.hasCentralObject === true,
    recommendedAction: normalizeAction(parsed.recommendedAction),
  };
}

function normalizeAction(value: unknown): BackgroundVisionValidation["recommendedAction"] {
  return value === "fallback" || value === "regenerate" || value === "accept" ? value : "regenerate";
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function imageInputToBuffer(image: string): Promise<Buffer> {
  if (image.startsWith("data:")) {
    return Buffer.from(image.split(",")[1], "base64");
  }

  const res = await axios.get(image, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

export async function analyzeGeneratedBackground(backgroundBuffer: Buffer): Promise<BackgroundSuitability> {
  const metadata = await sharp(backgroundBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const overallStats = await sharp(backgroundBuffer).stats();
  const overallBrightness = overallStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const centerBuffer = await sharp(backgroundBuffer)
    .extract({
      left: Math.round(width * 0.32),
      top: Math.round(height * 0.25),
      width: Math.max(1, Math.round(width * 0.36)),
      height: Math.max(1, Math.round(height * 0.42)),
    })
    .png()
    .toBuffer();
  const centerStats = await sharp(centerBuffer).stats();
  const centerContrast = centerStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / 3;
  const centerBrightness = centerStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const centerTooBusy = centerContrast > 68 && Math.abs(centerBrightness - overallBrightness) > 45;
  const exposureBad = overallBrightness > 238 || overallBrightness < 16;
  const placementZoneQuality = await validateBackgroundPlacementZone(backgroundBuffer);

  return {
    accepted: placementZoneQuality.accepted && !centerTooBusy && !exposureBad,
    reason: !placementZoneQuality.accepted
      ? placementZoneQuality.reason
      : centerTooBusy
      ? "center appears occupied or too busy"
      : exposureBad
        ? "background exposure unsuitable"
        : "background suitable",
    overallBrightness,
    centerBrightness,
    centerContrast,
  };
}

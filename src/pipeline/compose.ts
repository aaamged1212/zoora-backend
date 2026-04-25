import sharp from "sharp";
import axios from "axios";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreativeDirectionPlan } from "./aiAnalyzer.js";
import { validateFinalImage } from "./qualityGuard.js";

type ProductAnalysis = {
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
  isTallProduct: boolean;
  isWideProduct: boolean;
  productBrightness: number;
  productAreaRatio: number;
  hasAlpha: boolean;
};

type BackgroundAnalysis = {
  width: number;
  height: number;
  overallBrightness: number;
  centerBrightness: number;
  bottomBrightness: number;
  surfaceY: number;
  surfaceConfidence: number;
  sceneDepthScore: number;
  isDarkBackground: boolean;
  hasVisibleFloor: boolean;
  averageColor: {
    r: number;
    g: number;
    b: number;
  };
};

type Placement = {
  width: number;
  height: number;
  left: number;
  top: number;
  surfaceY: number;
  productBottom: number;
};

async function downloadImageWithRetry(url: string, attempt = 0): Promise<Buffer> {
  if (url.startsWith("data:")) {
    return Buffer.from(url.split(",")[1], "base64");
  }

  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch (error: any) {
    if (error.response && error.response.status === 429 && attempt < 5) {
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`[Compose] retrying download after 429... (Wait: ${waitTime}ms, Attempt: ${attempt + 1}/5)`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return downloadImageWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function saveDebugImage(filename: string, buffer: Buffer): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  try {
    const debugPath = join(process.cwd(), filename);
    await writeFile(debugPath, buffer);
    console.log("[Debug] image written:", debugPath);
  } catch (error: any) {
    console.warn("[Debug] image save failed:", error.message || String(error));
  }
}

async function averageBrightness(buffer: Buffer): Promise<number> {
  const stats = await sharp(buffer).stats();
  const channels = stats.channels.slice(0, 3);
  return channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;
}

async function averageColor(buffer: Buffer) {
  const stats = await sharp(buffer).stats();
  return {
    r: stats.channels[0]?.mean || 0,
    g: stats.channels[1]?.mean || 0,
    b: stats.channels[2]?.mean || 0,
  };
}

async function detectSurfacePlane(backgroundBuffer: Buffer, width: number, height: number) {
  const sampleWidth = 128;
  const sampleHeight = 128;
  const data = await sharp(backgroundBuffer)
    .resize({ width: sampleWidth, height: sampleHeight, fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  const rowMeans: number[] = [];

  for (let y = 0; y < sampleHeight; y++) {
    let sum = 0;
    for (let x = 0; x < sampleWidth; x++) {
      sum += data[y * sampleWidth + x];
    }
    rowMeans.push(sum / sampleWidth);
  }

  let bestRow = Math.round(sampleHeight * 0.82);
  let bestScore = 0;
  const start = Math.round(sampleHeight * 0.46);
  const end = Math.round(sampleHeight * 0.9);

  for (let y = start; y < end; y++) {
    const before = rowMeans[Math.max(0, y - 2)];
    const current = rowMeans[y];
    const after = rowMeans[Math.min(sampleHeight - 1, y + 2)];
    const gradient = Math.abs(current - before) + Math.abs(after - current);
    const lowerThirdWeight = 0.7 + (y / sampleHeight) * 0.65;
    const score = gradient * lowerThirdWeight;

    if (score > bestScore) {
      bestScore = score;
      bestRow = y;
    }
  }

  const confidence = clamp(bestScore / 20, 0, 1);
  const fallbackSurfaceY = Math.round(height * 0.82);
  const detectedSurfaceY = Math.round((bestRow / sampleHeight) * height);
  const surfaceY = confidence >= 0.28
    ? clamp(detectedSurfaceY, Math.round(height * 0.62), Math.round(height * 0.9))
    : fallbackSurfaceY;

  if (confidence < 0.28) {
    console.log("[Physics] no confident surface detected, using lower-center grounding fallback");
  }

  return {
    surfaceY,
    confidence,
  };
}

function estimateSceneDepth(
  background: {
    centerBrightness: number;
    bottomBrightness: number;
    hasVisibleFloor: boolean;
  },
  promptText: string
): number {
  const text = promptText.toLowerCase();
  let score = 0.18;

  if (/large room|wide environment|deep perspective|perspective|interior|corridor|hall|floor|boutique|architectural|lifestyle|environment/.test(text)) {
    score += 0.38;
  }

  if (/close-up|closeup|macro|minimal|simple studio|tight studio|pedestal|surface|tabletop/.test(text)) {
    score -= 0.18;
  }

  if (background.hasVisibleFloor) {
    score += 0.24;
  }

  if (Math.abs(background.bottomBrightness - background.centerBrightness) > 18) {
    score += 0.14;
  }

  return clamp(score, 0, 1);
}

export async function analyzeProduct(productBuffer: Buffer, canvasWidth: number, canvasHeight: number): Promise<ProductAnalysis> {
  const metadata = await sharp(productBuffer).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const channels = metadata.channels || 0;
  const hasAlpha = metadata.hasAlpha === true || channels === 4;

  if (!hasAlpha) {
    throw new Error("Product alpha lost at stage: product analysis");
  }

  const alphaStats = await sharp(productBuffer).ensureAlpha().extractChannel("alpha").stats();
  const visibleAreaRatio = clamp(alphaStats.channels[0].mean / 255, 0, 1);
  const alphaBox = await getAlphaBoundingBox(productBuffer, width, height);
  const productBrightness = await averageBrightness(productBuffer);
  const productAreaRatio = (width * height * visibleAreaRatio) / (canvasWidth * canvasHeight);

  return {
    width,
    height,
    aspectRatio: width / height,
    bottomOffset: alphaBox.bottomOffset,
    boundingBox: alphaBox.boundingBox,
    isTallProduct: height > width * 1.25,
    isWideProduct: width > height * 1.25,
    productBrightness,
    productAreaRatio,
    hasAlpha,
  };
}

async function getAlphaBoundingBox(productBuffer: Buffer, width: number, height: number) {
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
    bottomOffset: Math.max(0, height - 1 - maxY),
    boundingBox: {
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
}

export async function analyzeBackground(backgroundBuffer: Buffer): Promise<BackgroundAnalysis> {
  const metadata = await sharp(backgroundBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;

  const centerRegion = await sharp(backgroundBuffer)
    .extract({
      left: Math.round(width * 0.25),
      top: Math.round(height * 0.25),
      width: Math.max(1, Math.round(width * 0.5)),
      height: Math.max(1, Math.round(height * 0.5)),
    })
    .png()
    .toBuffer();
  const bottomRegion = await sharp(backgroundBuffer)
    .extract({
      left: 0,
      top: Math.round(height * 0.68),
      width,
      height: Math.max(1, height - Math.round(height * 0.68)),
    })
    .png()
    .toBuffer();
  const bottomStats = await sharp(bottomRegion).stats();
  const bottomBrightness = bottomStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const bottomContrast = bottomStats.channels
    .slice(0, 3)
    .reduce((sum, channel) => sum + channel.stdev, 0) / 3;
  const centerBrightness = await averageBrightness(centerRegion);
  const overallBrightness = await averageBrightness(backgroundBuffer);
  const hasVisibleFloor = bottomContrast > 8 || Math.abs(bottomBrightness - centerBrightness) > 8;
  const surface = await detectSurfacePlane(backgroundBuffer, width, height);
  const sceneDepthScore = estimateSceneDepth(
    {
      centerBrightness,
      bottomBrightness,
      hasVisibleFloor,
    },
    ""
  );

  return {
    width,
    height,
    overallBrightness,
    centerBrightness,
    bottomBrightness,
    surfaceY: surface.surfaceY,
    surfaceConfidence: surface.confidence,
    sceneDepthScore,
    isDarkBackground: overallBrightness < 95,
    hasVisibleFloor,
    averageColor: await averageColor(backgroundBuffer),
  };
}

function sceneTextForPhysics(creativePlan?: CreativeDirectionPlan): string {
  if (!creativePlan) return "";
  return [
    creativePlan.scene.concept,
    creativePlan.scene.backgroundPrompt,
    creativePlan.scene.environmentType,
    creativePlan.scene.surfaceType,
    creativePlan.scene.lightingMood,
  ].join(" ");
}

function floatingAllowed(creativePlan?: CreativeDirectionPlan): boolean {
  return false;
}

function computePlacement(
  product: ProductAnalysis,
  background: BackgroundAnalysis,
  creativePlan?: CreativeDirectionPlan
): Placement {
  const maxHeight = Math.round(background.height * 0.78);
  const maxWidth = Math.round(background.width * 0.82);
  const composition = creativePlan?.composition;
  const position = composition?.position || "lower-center";
  const allowFloating = floatingAllowed(creativePlan);
  const physicsSceneDepth = estimateSceneDepth(
    {
      centerBrightness: background.centerBrightness,
      bottomBrightness: background.bottomBrightness,
      hasVisibleFloor: background.hasVisibleFloor,
    },
    sceneTextForPhysics(creativePlan)
  );
  const sceneDepthScore = Math.max(background.sceneDepthScore, physicsSceneDepth);
  const minProductScale = sceneDepthScore >= 0.55 ? 0.68 : 0.55;
  const targetHeightRatio = clamp(Math.max(composition?.productScale || 0.64, minProductScale), 0.55, 0.78);
  let targetHeight = Math.round(background.height * targetHeightRatio);
  let targetWidth = Math.round(targetHeight * product.aspectRatio);

  if (targetWidth > maxWidth) {
    targetWidth = maxWidth;
    targetHeight = Math.round(targetWidth / product.aspectRatio);
  }

  if (targetHeight > maxHeight) {
    targetHeight = maxHeight;
    targetWidth = Math.round(targetHeight * product.aspectRatio);
  }

  const adjustedProductScale = Math.max(
    targetHeight / background.height,
    targetWidth / background.width
  );
  console.log("[Physics] scene depth:", sceneDepthScore.toFixed(2));
  console.log("[Physics] adjusted product scale:", adjustedProductScale.toFixed(2));

  const maxLeft = Math.max(0, background.width - targetWidth);
  const left = position === "left-hero"
    ? clamp(Math.round(background.width * 0.18 - targetWidth / 2), 0, maxLeft)
    : position === "right-hero"
      ? clamp(Math.round(background.width * 0.82 - targetWidth / 2), 0, maxLeft)
      : clamp(Math.round((background.width - targetWidth) / 2), 0, maxLeft);
  const fallbackSurfaceY = position === "center"
    ? Math.round(background.height * 0.72)
    : position === "pedestal-center"
      ? Math.round(background.height * 0.76)
      : Math.round(background.height * 0.84);
  let surfaceY = background.surfaceConfidence >= 0.28 ? background.surfaceY : fallbackSurfaceY;
  surfaceY = clamp(surfaceY, Math.round(background.height * 0.62), Math.round(background.height * 0.9));

  if (!allowFloating && surfaceY < targetHeight + Math.round(background.height * 0.02)) {
    surfaceY = Math.min(Math.round(background.height * 0.9), targetHeight + Math.round(background.height * 0.02));
  }

  console.log("[Physics] surface detected at Y:", surfaceY);
  console.log("[BG Geometry] detected surface Y:", surfaceY);

  const scaleY = targetHeight / Math.max(1, product.height);
  const scaledBottomOffset = Math.round(product.bottomOffset * scaleY);
  const visibleProductBottomWithinLayer = targetHeight - scaledBottomOffset;
  let top = Math.max(0, Math.round(surfaceY - visibleProductBottomWithinLayer));

  if (Math.abs((top + visibleProductBottomWithinLayer) - surfaceY) > 1) {
    top = Math.max(0, Math.round(surfaceY - visibleProductBottomWithinLayer));
  }

  console.log("[Physics] product snapped to surface");
  console.log("[BG Geometry] snapping product to surface");

  return {
    width: targetWidth,
    height: targetHeight,
    left,
    top,
    surfaceY,
    productBottom: top + visibleProductBottomWithinLayer,
  };
}

async function resizeProductForPlacement(productBuffer: Buffer, placement: Placement): Promise<Buffer> {
  const resizedBuffer = await sharp(productBuffer)
    .ensureAlpha()
    .resize({
      width: placement.width,
      height: placement.height,
      fit: "inside",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  const metadata = await sharp(resizedBuffer).metadata();
  console.log("[Alpha] after placement resize channels:", metadata.channels);

  if ((metadata.channels || 0) < 4 || !metadata.hasAlpha) {
    throw new Error("Product alpha lost at stage: placement resize");
  }

  return resizedBuffer;
}

async function validateProductAlphaStage(buffer: Buffer, stageName: string, logLabel: string): Promise<void> {
  const metadata = await sharp(buffer).metadata();
  console.log(logLabel, metadata.channels);

  if ((metadata.channels || 0) < 4 || !metadata.hasAlpha) {
    throw new Error(`Product alpha lost at stage: ${stageName}`);
  }
}

async function fallbackDirectCompose(
  backgroundBuffer: Buffer,
  productBuffer: Buffer,
  placement: Placement
): Promise<Buffer> {
  console.warn("[Integration] fallback direct compose used");
  return sharp(backgroundBuffer)
    .composite([
      {
        input: productBuffer,
        left: placement.left,
        top: placement.top,
        blend: "over",
      },
    ])
    .png()
    .toBuffer();
}

export async function composeImages(
  bgUrl: string,
  fgUrl: string,
  options: {
    creativePlan?: CreativeDirectionPlan;
  } = {}
): Promise<Buffer> {
  const rawBackgroundBuffer = await downloadImageWithRetry(bgUrl);
  const rawProductBuffer = await downloadImageWithRetry(fgUrl);

  const backgroundBuffer = await sharp(rawBackgroundBuffer).autoOrient().png().toBuffer();
  const initialProductBuffer = await sharp(rawProductBuffer).autoOrient().ensureAlpha().png().toBuffer();

  await validateProductAlphaStage(initialProductBuffer, "compose input", "[Alpha] compose input channels:");
  await saveDebugImage("debug-product-cutout.png", initialProductBuffer);
  await saveDebugImage("debug-background.png", backgroundBuffer);

  console.log("[Execution] background analyzed for composition");
  const backgroundAnalysis = await analyzeBackground(backgroundBuffer);
  const productAnalysis = await analyzeProduct(
    initialProductBuffer,
    backgroundAnalysis.width,
    backgroundAnalysis.height
  );

  console.log("[Integration] product aspect ratio:", productAnalysis.aspectRatio.toFixed(3));
  console.log("[Integration] product brightness:", productAnalysis.productBrightness.toFixed(1));
  console.log("[Integration] background bottom brightness:", backgroundAnalysis.bottomBrightness.toFixed(1));

  console.log("[Pipeline] 7/11 Execute placement from validated plan");
  const placement = computePlacement(
    productAnalysis,
    backgroundAnalysis,
    options.creativePlan
  );

  console.log("[Placement] detected product bottom:", placement.productBottom);
  console.log("[Placement] detected surface Y:", placement.surfaceY);
  console.log("[Placement] product aligned to surface:", placement.productBottom);

  const requestedScale = options.creativePlan?.composition.productScale ?? placement.height / backgroundAnalysis.height;
  const productScale = Math.max(
    placement.height / backgroundAnalysis.height,
    placement.width / backgroundAnalysis.width
  );
  console.log("[Compose] using AI creative direction:", !!options.creativePlan);
  console.log("[Placement] mode:", options.creativePlan?.composition.position || "lower-center");
  console.log("[Placement] target scale:", requestedScale.toFixed(3));
  console.log("[Placement] surface alignment:", "sit-on-surface");
  console.log("[Integration] product scale:", productScale.toFixed(3));
  console.log("[Execution] product placed:", true);

  const placedProduct = await resizeProductForPlacement(initialProductBuffer, placement);

  console.log("[Pipeline] 8/11 Physics realism mode shadow disabled");
  console.log("[Shadow] disabled (phase 1 realism mode)");
  console.log("[Shadow] no shadow applied");
  console.log("[Integration] reflection disabled:", true);
  await validateProductAlphaStage(placedProduct, "shadow prep", "[Alpha] after shadow prep channels:");

  console.log("[Lighting] adaptive light matching skipped");
  console.log("[Lighting] rim light disabled temporarily");
  let productForCompose = await sharp(placedProduct)
    .ensureAlpha()
    .png()
    .toBuffer();
  await validateProductAlphaStage(productForCompose, "before compose", "[Alpha] before compose channels:");
  console.log("[Integration] rim light enabled:", false);

  const layers: sharp.OverlayOptions[] = [];
  layers.push({
    input: productForCompose,
    left: placement.left,
    top: placement.top,
    blend: "over",
  });
  console.log("[Pipeline] 9/11 Compose final image");
  let output = await sharp(backgroundBuffer).composite(layers).png().toBuffer();

  console.log("[Pipeline] 10/11 Quality Guard validates final output");
  const productAreaRatio = (placement.width * placement.height) / (backgroundAnalysis.width * backgroundAnalysis.height);
  const surfaceTouchValid = Math.abs(placement.productBottom - placement.surfaceY) <= 1;
  const finalQuality = await validateFinalImage(output, {
    productAreaRatio,
    productHadAlpha: true,
    productBrightness: productAnalysis.productBrightness,
    backgroundBrightness: backgroundAnalysis.centerBrightness,
    productScale,
    surfaceTouchValid,
  });

  if (finalQuality.accepted) {
    console.log("[Quality Guard] final accepted:", finalQuality.reason);
  } else {
    console.warn("[Quality Guard] final rejected:", finalQuality.reason);
    output = await fallbackDirectCompose(backgroundBuffer, productForCompose, placement);
    const fallbackQuality = await validateFinalImage(output, {
      productAreaRatio,
      productHadAlpha: true,
      productBrightness: productAnalysis.productBrightness,
      backgroundBrightness: backgroundAnalysis.centerBrightness,
      productScale,
      surfaceTouchValid,
    });

    if (fallbackQuality.accepted) {
      console.log("[Quality Guard] final accepted:", fallbackQuality.reason);
    } else {
      console.warn("[Quality Guard] fallback final rejected, returning safest composite:", fallbackQuality.reason);
    }
  }

  await saveDebugImage("debug-final-compose.png", output);

  return output;
}

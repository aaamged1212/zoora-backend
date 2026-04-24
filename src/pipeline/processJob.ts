import sharp from "sharp";
import axios from "axios";
import { removeBackground } from "./rembg.js";
import { generateBackground } from "./generateBackground.js";
import { enhanceProduct, finalPolish, type EnhanceMode } from "./enhance.js";
import { composeImages } from "./compose.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEnhanceMode(mode?: string): EnhanceMode {
  if (mode === "pro" || mode === "ultra") {
    return mode;
  }

  return "fast";
}

export async function processJob(input: {
  image: string;
  prompt?: string;
  enhanceMode?: string;
}): Promise<Buffer> {
  console.log("[worker] Starting job pipeline...");
  let { image } = input;
  const { prompt } = input;
  const enhanceMode = normalizeEnhanceMode(input.enhanceMode);

  if (!image) {
    throw new Error("Input must contain an 'image' URL.");
  }

  console.log("[Pipeline] 1/6 Load product image");
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

  console.log("[Pipeline] 2/6 Remove background");
  const cutout = await removeBackground(image);
  
  await delay(1500);

  console.log("[Pipeline] 3/6 Local cutout polish");
  let cutoutBuffer: Buffer;
  if (cutout.startsWith("data:")) {
    cutoutBuffer = Buffer.from(cutout.split(",")[1], "base64");
  } else {
    const res = await axios.get(cutout, { responseType: "arraybuffer" });
    cutoutBuffer = Buffer.from(res.data);
  }

  const finalEnhancedBuffer = await enhanceProduct(cutoutBuffer, { mode: enhanceMode });

  const finalEnhancedCutoutUrl = `data:image/png;base64,${finalEnhancedBuffer.toString("base64")}`;

  await delay(1500);

  console.log("[Pipeline] 4/6 Generate background");
  const bg = await generateBackground(prompt || "studio lighting background");

  console.log("[Pipeline] 5/6 Compose product with background");
  const composedImage = await composeImages(bg, finalEnhancedCutoutUrl);
  console.log(`[Pipeline] 6/6 Final polish: ${enhanceMode}`);
  const finalImage = await finalPolish(composedImage, enhanceMode);

  console.log("[worker] Final image ready.");
  return finalImage;
}

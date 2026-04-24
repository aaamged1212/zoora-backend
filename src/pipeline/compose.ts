import sharp from "sharp";
import axios from "axios";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function composeImages(bgUrl: string, fgUrl: string): Promise<Buffer> {
  console.log("[Compose] compositing images...");
  console.log("[Compose] simplified alpha-safe compose enabled");
  console.log("[Compose] trim disabled");
  console.log("[Compose] shadow disabled");
  console.log("[Compose] flatten disabled");
  
  const bgBuffer = await downloadImageWithRetry(bgUrl);
  const productBuffer = await downloadImageWithRetry(fgUrl);

  const backgroundBuffer = await sharp(bgBuffer)
    .autoOrient()
    .png()
    .toBuffer();
  const bgMeta = await sharp(backgroundBuffer).metadata();
  const bgWidth = bgMeta.width || 1024;
  const bgHeight = bgMeta.height || 1024;

  const targetProductHeight = Math.floor(bgHeight * 0.65);
  const targetProductWidthLimit = Math.floor(bgWidth * 0.80);

  const productPng = await sharp(productBuffer)
    .autoOrient()
    .ensureAlpha()
    .resize({
      height: targetProductHeight,
      width: targetProductWidthLimit,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const productMeta = await sharp(productPng).metadata();
  const productWidth = productMeta.width || 0;
  const productHeight = productMeta.height || 0;

  console.log("[Compose] product channels:", productMeta.channels);
  console.log("[Compose] product has alpha:", productMeta.hasAlpha === true || (productMeta.channels || 0) >= 4);
  console.log("[Compose] black background check:", productMeta.hasAlpha === true ? "alpha present" : "missing alpha");
  console.log("[Compose] using alpha-safe product:", true);

  if (process.env.NODE_ENV !== "production") {
    try {
      const debugProductPath = join(process.cwd(), "debug-product-before-compose.png");
      const debugBackgroundPath = join(process.cwd(), "debug-background-before-compose.png");

      await writeFile(debugProductPath, productPng);
      await writeFile(debugBackgroundPath, backgroundBuffer);
      console.log("[Compose] debug image written:", debugProductPath);
      console.log("[Compose] debug image written:", debugBackgroundPath);
    } catch (error: any) {
      console.warn("[Compose] debug save failed:", error.message || String(error));
    }
  }

  const left = Math.max(0, Math.floor((bgWidth - productWidth) / 2));
  const top = Math.max(0, Math.floor((bgHeight - productHeight) / 2));

  console.log("[Compose] background dimensions:", bgWidth, bgHeight);
  console.log("[Compose] product resized dimensions:", productWidth, productHeight);
  console.log("[Compose] composite position:", left, top);

  const output = await sharp(backgroundBuffer)
    .png()
    .composite([
      {
        input: productPng,
        left: left,
        top: top,
        blend: "over",
      }
    ])
    .png()
    .toBuffer();

  if (process.env.NODE_ENV !== "production") {
    try {
      const debugFinalPath = join(process.cwd(), "debug-final-compose.png");

      await writeFile(debugFinalPath, output);
      console.log("[Compose] debug image written:", debugFinalPath);
    } catch (error: any) {
      console.warn("[Compose] debug save failed:", error.message || String(error));
    }
  }

  console.log("[Compose] final composite completed");
  return output;
}

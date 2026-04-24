import sharp from "sharp";
import axios from "axios";

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
      console.log(`[Pipeline] Retrying download after 429... (Wait: ${waitTime}ms, Attempt: ${attempt + 1}/5)`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return downloadImageWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

export async function composeImages(bgUrl: string, fgUrl: string): Promise<Buffer> {
  console.log("[Pipeline] 4/4: Compositing images...");
  
  const bgBuffer = await downloadImageWithRetry(bgUrl);
  const fgBuffer = await downloadImageWithRetry(fgUrl);

  const bg = sharp(bgBuffer);
  const bgMeta = await bg.metadata();
  const bgWidth = bgMeta.width || 1024;
  const bgHeight = bgMeta.height || 1024;

  // Auto-orient and trim transparent space to ensure perfect scaling and centering
  const orientedFgBuffer = await sharp(fgBuffer).autoOrient().toBuffer();
  const trimmedFgBuffer = await sharp(orientedFgBuffer)
    .trim()
    .toBuffer()
    .catch(() => orientedFgBuffer); // Fallback if trim fails (e.g. no transparency to trim)

  const fgMeta = await sharp(trimmedFgBuffer).metadata();
  const productWidth = fgMeta.width || 1024;
  const productHeight = fgMeta.height || 1024;

  console.log("[Compose] product original hasAlpha:", fgMeta.hasAlpha, "format:", fgMeta.format);

  const targetProductHeight = Math.floor(bgHeight * 0.65);
  const targetProductWidthLimit = Math.floor(bgWidth * 0.80);

  let resizedFgBuffer = await sharp(trimmedFgBuffer)
    .ensureAlpha()
    .resize({
      height: targetProductHeight,
      width: targetProductWidthLimit,
      fit: "inside",
      withoutEnlargement: false,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  let resizedMeta = await sharp(resizedFgBuffer).metadata();
  let resizedWidth = resizedMeta.width || 0;
  let resizedHeight = resizedMeta.height || 0;

  if (resizedWidth > bgWidth || resizedHeight > bgHeight) {
    resizedFgBuffer = await sharp(resizedFgBuffer)
      .ensureAlpha()
      .resize({
        width: Math.floor(bgWidth * 0.75),
        height: Math.floor(bgHeight * 0.65),
        fit: "inside",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
    resizedMeta = await sharp(resizedFgBuffer).metadata();
    resizedWidth = resizedMeta.width || 0;
    resizedHeight = resizedMeta.height || 0;
  }

  const left = Math.max(0, Math.floor((bgWidth - resizedWidth) / 2));
  const top = Math.max(0, Math.floor((bgHeight - resizedHeight) / 2));

  console.log("[Compose] background dimensions:", bgWidth, bgHeight);
  console.log("[Compose] product original dimensions:", productWidth, productHeight);
  console.log("[Compose] product resized dimensions:", resizedWidth, resizedHeight);
  console.log("[Compose] composite position:", left, top);
  console.log("[Compose] product resized channels:", resizedMeta.channels);
  console.log("[Compose] flatten used: false");

  console.log("[Compose] generating realistic shadows...");
  
  const shadowPadding = 100;

  // Extract alpha channel from the resized foreground, with padding to prevent clipping
  const paddedAlphaBuffer = await sharp(resizedFgBuffer)
    .extend({
      top: shadowPadding,
      bottom: shadowPadding,
      left: shadowPadding,
      right: shadowPadding,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .extractChannel("alpha")
    .toBuffer();

  // 1. Soft shadow (wide blur, low opacity, dropped vertically)
  const softShadowAlpha = await sharp(paddedAlphaBuffer).linear(0.3).toBuffer();
  const softShadowBuffer = await sharp({
    create: {
      width: resizedWidth + shadowPadding * 2,
      height: resizedHeight + shadowPadding * 2,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .joinChannel(softShadowAlpha)
    .blur(25)
    .png()
    .toBuffer();

  // 2. Contact shadow (tight blur, high opacity, right beneath the object)
  const contactShadowAlpha = await sharp(paddedAlphaBuffer).linear(0.8).toBuffer();
  const contactShadowBuffer = await sharp({
    create: {
      width: resizedWidth + shadowPadding * 2,
      height: resizedHeight + shadowPadding * 2,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .joinChannel(contactShadowAlpha)
    .blur(4)
    .png()
    .toBuffer();

  const result = await bg
    .composite([
      { input: softShadowBuffer, left: left - shadowPadding, top: top - shadowPadding + 20 },
      { input: contactShadowBuffer, left: left - shadowPadding, top: top - shadowPadding + 4 },
      {
        input: resizedFgBuffer,
        left: left,
        top: top
      }
    ])
    .png()
    .toBuffer();

  console.log("[Pipeline] 4/4: Composition complete.");
  return result;
}
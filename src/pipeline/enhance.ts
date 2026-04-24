import { runReplicate } from "./replicateHelper.js";

export async function enhanceImage(imageUrl: string): Promise<string> {
  console.log("[Pipeline] 2/4: Enhancing image quality...");
  const output = await runReplicate(
    "f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
    { image: imageUrl }
  );
  const resultUrl = Array.isArray(output) ? output[0] : output;
  console.log(`[Pipeline] 2/4: Normalized output URL: ${resultUrl}`);
  return resultUrl as string;
}
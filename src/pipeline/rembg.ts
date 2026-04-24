import { runReplicate } from "./replicateHelper.js";

export async function removeBackground(imageUrl: string): Promise<string> {
  console.log("[Rembg] removing background...");
  const output = await runReplicate(
    "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
    { image: imageUrl }
  );
  const resultUrl = Array.isArray(output) ? output[0] : output;
  console.log(`[Rembg] normalized output URL: ${resultUrl}`);
  return resultUrl as string;
}

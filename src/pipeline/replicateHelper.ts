import axios from "axios";

async function requestWithRetry(requestFn: () => Promise<any>, attempt = 0): Promise<any> {
  try {
    return await requestFn();
  } catch (error: any) {
    if (error.response && error.response.status === 429) {
      if (attempt < 5) {
        const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        console.log(`[Replicate] retrying after 429... (Wait: ${waitTime}ms, Attempt: ${attempt + 1}/5)`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return requestWithRetry(requestFn, attempt + 1);
      } else {
        throw new Error("[Replicate] Rate limit exceeded after maximum retries.");
      }
    }
    throw error;
  }
}

export async function runReplicate(version: string, input: any): Promise<any> {
  console.log("[Replicate] start...");

  const headers = {
    Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  let { data: prediction } = await requestWithRetry(() =>
    axios.post(
      "https://api.replicate.com/v1/predictions",
      { version, input },
      { headers }
    )
  );

  // Poll the prediction status until it finishes
  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled"
  ) {
    console.log("[Replicate] polling status:", prediction.status);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { data } = await requestWithRetry(() =>
      axios.get(`https://api.replicate.com/v1/predictions/${prediction.id}`, { headers })
    );
    prediction = data;
  }

  if (prediction.status !== "succeeded") {
    console.error("[Replicate] failed:", prediction.error);
    throw new Error(`Replicate prediction failed: ${prediction.error}`);
  }

  console.log("[Replicate] success");
  return prediction.output;
}
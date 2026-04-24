import axios from "axios";
import { ENV } from "../config/env.js";

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

function getPredictionRequest(identifier: string, input: any) {
  const modelVersion = identifier.match(/^([^/]+)\/([^:]+):(.+)$/);

  if (modelVersion) {
    return {
      url: "https://api.replicate.com/v1/predictions",
      body: { version: modelVersion[3], input },
    };
  }

  const model = identifier.match(/^([^/]+)\/([^:]+)$/);

  if (model) {
    return {
      url: `https://api.replicate.com/v1/models/${model[1]}/${model[2]}/predictions`,
      body: { input },
    };
  }

  return {
    url: "https://api.replicate.com/v1/predictions",
    body: { version: identifier, input },
  };
}

export async function runReplicate(identifier: string, input: any): Promise<any> {
  console.log("[Replicate] start...");

  const headers = {
    Authorization: `Token ${ENV.REPLICATE_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const request = getPredictionRequest(identifier, input);

  let { data: prediction } = await requestWithRetry(() =>
    axios.post(
      request.url,
      request.body,
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

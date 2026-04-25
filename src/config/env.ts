import dotenv from "dotenv";

dotenv.config();

export function getEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    const message = `Missing environment variable: ${name}`;
    console.error(`[ENV] ${message}`);
    throw new Error(message);
  }

  return value;
}

export const ENV = {
  REPLICATE_API_TOKEN: getEnv("REPLICATE_API_TOKEN"),
  BG_MODEL_FAST: getEnv("BG_MODEL_FAST"),
  BG_MODEL_PRO: getEnv("BG_MODEL_PRO"),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MAX_BG_RETRIES_FAST: process.env.MAX_BG_RETRIES_FAST || "0",
  MAX_BG_RETRIES_PRO: process.env.MAX_BG_RETRIES_PRO || "1",
  GUARDIAN_STRICTNESS: process.env.GUARDIAN_STRICTNESS || "balanced",
  SUPABASE_URL: getEnv("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  PORT: process.env.PORT || "3000",
};

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
  REPLICATE_FAST_ENHANCE_VERSION: getEnv("REPLICATE_FAST_ENHANCE_VERSION"),
  REPLICATE_SUPIR_VERSION: getEnv("REPLICATE_SUPIR_VERSION"),
  SUPABASE_URL: getEnv("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  PORT: process.env.PORT || "3000",
};

import { config } from "dotenv";
import { join } from "path";

config({ path: join(__dirname, "..", ".env") });

export function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

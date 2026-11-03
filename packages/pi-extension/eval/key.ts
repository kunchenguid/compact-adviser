import type { JudgeProvider } from "../src/decisions.ts";

export function judgeKeyFromEnv(provider: JudgeProvider): string {
  if (provider === "typesafe") return typesafeKeyFromEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is missing from the launch environment (do not pass it as argv)");
  return key;
}

/** Read TYPESAFE_API_KEY from the environment only. Never pass it as argv. */
export function typesafeKeyFromEnv(): string {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    console.error("TYPESAFE_API_KEY is missing from the environment (do not pass it as argv)");
    process.exit(1);
  }
  return key;
}

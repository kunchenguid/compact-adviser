/** Read OPENROUTER_API_KEY from the environment only. Never pass it as argv. */
export function openrouterKeyFromEnv(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.error("OPENROUTER_API_KEY is missing from the environment (do not pass it as argv)");
    process.exit(1);
  }
  return key;
}

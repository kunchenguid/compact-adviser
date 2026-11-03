import type { JudgeProfile } from "./profile.ts";

export type JudgeProvider = "typesafe" | "openai-decisions";
export const DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const DECISIONS_MODEL = "gpt-6-luna";
export const INVALID_PROVIDER_MESSAGE =
  "COMPACT_ADVISER_PROVIDER must be typesafe or openai-decisions. No request or advice was made.";

export function selectedProvider(value: string | undefined): JudgeProvider | undefined {
  const name = value?.trim() ?? "";
  if (name === "" || name === "typesafe") return "typesafe";
  return name === "openai-decisions" ? name : undefined;
}

export function providerStatus(provider: JudgeProvider | undefined): string {
  if (provider === "typesafe") return "";
  return provider === "openai-decisions"
    ? "Provider: OpenAI Decisions (experimental; OPENAI_API_KEY from launch environment only). "
    : `${INVALID_PROVIDER_MESSAGE} `;
}

export function decisionsRequest(
  state: unknown,
  questions: NonNullable<JudgeProfile["questions"]>,
): unknown {
  return {
    model: DECISIONS_MODEL,
    input: JSON.stringify(state),
    questions: Object.entries(questions).map(([name, question]) => ({
      type: "choice",
      name,
      instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({
        value,
        description,
      })),
    })),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response");
  return value as Record<string, unknown>;
}

export function normalizeDecisions(value: unknown): unknown {
  const response = object(value);
  if (
    response.model !== DECISIONS_MODEL ||
    !Array.isArray(response.answers) ||
    response.answers.length !== 2
  )
    throw new Error("response");
  const answers: Record<string, unknown> = {};
  for (const item of response.answers) {
    const answer = object(item);
    const name = answer.name;
    if (
      (name !== "done" && name !== "shape") ||
      Object.hasOwn(answers, name) ||
      answer.type !== "choice" ||
      !Array.isArray(answer.probabilities)
    )
      throw new Error("response");
    const options =
      name === "done"
        ? ["finished", "not_finished", "unclear"]
        : ["hands_on", "coordinating", "unclear"];
    if (answer.probabilities.length !== options.length) throw new Error("response");
    const probabilities: Record<string, unknown> = {};
    for (const item of answer.probabilities) {
      const entry = object(item);
      if (
        typeof entry.value !== "string" ||
        !options.includes(entry.value) ||
        Object.hasOwn(probabilities, entry.value)
      )
        throw new Error("response");
      probabilities[entry.value] = entry.probability;
    }
    answers[name] = {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities,
    };
  }
  return { model: response.model, answers, usage: response.usage };
}

export function decisionsQuotaError(text: string): boolean {
  try {
    const error = object(object(JSON.parse(text)).error);
    return (
      error.type === "insufficient_quota" ||
      [
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
      ].includes(typeof error.code === "string" ? error.code : "")
    );
  } catch {
    return false;
  }
}

export function providerMessage(message: string, provider: JudgeProvider): string {
  return provider === "typesafe"
    ? message
    : message.replaceAll("TypeSafe (Jev)", "OpenAI Decisions").replaceAll("TypeSafe", "OpenAI");
}

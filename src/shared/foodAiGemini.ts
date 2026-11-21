import { FoodAiError } from "./foodAiError";

export const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite"];
export const GEMINI_TIMEOUT_MS = 45_000;
export const GEMINI_FIRST_TRY_MS = 20_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GeminiQuestion {
  models: string[];
  system: string;
  schema: unknown;
  photos: { mediaType: string; data: string }[];
  text: string;
  maxTokens: number;
}

export type GeminiReply = { stop: "ok"; answer: unknown } | { stop: "refused" | "truncated" | "unreadable"; answer: null };

export function geminiRequest(q: GeminiQuestion): unknown {
  return {
    systemInstruction: { parts: [{ text: q.system }] },
    contents: [{ role: "user", parts: [...q.photos.map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } })), { text: q.text }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: q.schema, maxOutputTokens: q.maxTokens, thinkingConfig: { thinkingLevel: "low" } },
  };
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const REFUSING = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "LANGUAGE"]);

function failureOf(status: number, body: unknown, model: string): { error: FoodAiError; next: boolean } {
  const error = record(record(body)?.error), code = typeof error?.status === "string" ? error.status : "", text = typeof error?.message === "string" ? error.message : "";
  console.error(`food AI: gemini ${model} answered ${status}${code ? ` ${code}` : ""}`);
  if (/api key|API_KEY_INVALID/i.test(text) || status === 401 || status === 403) return { error: new FoodAiError("upstream", "Google refused the Gemini API key. Check GEMINI_API_KEY on the server."), next: false };
  if (/location is not supported/i.test(text)) return { error: new FoodAiError("upstream", "Gemini is not offered in the server's country."), next: false };
  if (status === 429) return { error: new FoodAiError("upstream", "The Gemini key's limit is reached for now (the free tier allows a few estimates a minute, and a number a day that starts again at midnight Pacific time). Try again later."), next: true };
  if (status === 404) return { error: new FoodAiError("unconfigured", `Gemini has no model named ${model}. Check FOOD_AI_MODEL on the server.`), next: true };
  if (status >= 500) return { error: new FoodAiError("upstream", "Gemini is having trouble right now. Try again."), next: true };
  return { error: new FoodAiError("upstream", "Gemini could not make this estimate. Try again."), next: true };
}

export function replyOf(body: unknown): GeminiReply {
  const response = record(body), candidate = Array.isArray(response?.candidates) ? record(response.candidates[0]) : null;
  if (!candidate) return record(response?.promptFeedback)?.blockReason ? { stop: "refused", answer: null } : { stop: "unreadable", answer: null };
  const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
  if (finish === "MAX_TOKENS") return { stop: "truncated", answer: null };
  if (REFUSING.has(finish)) return { stop: "refused", answer: null };
  const parts = record(candidate.content)?.parts, text = Array.isArray(parts) ? parts.map(record).filter((p) => p && !p.thought && typeof p.text === "string").map((p) => p!.text).join("") : "";
  try {
    return { stop: "ok", answer: JSON.parse(text) };
  } catch {
    return { stop: "unreadable", answer: null };
  }
}

export async function askGemini(question: GeminiQuestion, key: string, send: GeminiFetch = fetch): Promise<GeminiReply> {
  const body = JSON.stringify(geminiRequest(question)), models = question.models.map((m) => m.replace(/^models\//, ""));
  let failure = new FoodAiError("unconfigured", "No Gemini model is set. Check FOOD_AI_MODEL on the server.");
  for (const [i, model] of models.entries()) {
    const last = i === models.length - 1;
    let status: number, answer: unknown;
    try {
      const response = await send(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
        signal: AbortSignal.timeout(last ? GEMINI_TIMEOUT_MS : GEMINI_FIRST_TRY_MS),
      });
      status = response.status;
      answer = await response.json().catch(() => null);
    } catch (error) {
      const late = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      console.error(`food AI: gemini ${model} ${late ? "timed out" : "could not be reached"}`);
      failure = new FoodAiError("upstream", late ? "Gemini did not answer in time. Try again." : "Gemini could not be reached. Try again.");
      continue;
    }
    if (status >= 200 && status < 300) return replyOf(answer);
    const failed = failureOf(status, answer, model);
    failure = failed.error;
    if (!failed.next) break;
  }
  throw failure;
}

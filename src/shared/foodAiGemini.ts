/**
 * foodAiGemini.ts — asking Google's Gemini for an estimate (FOOD_AI_BACKEND=gemini), through the Gemini API's generateContent with a key
 * from Google AI Studio (GEMINI_API_KEY). A key on the free tier costs nothing and has daily limits, and Google may keep what is sent on it
 * (the words and photos) and use it to improve its products; a key on a paid project is not used that way.
 *
 * The question is the one Claude is asked: the same system prompt, the same JSON Schema (responseJsonSchema), the photos as inline data
 * before the words. The answer is the JSON text of the first candidate, checked by foodAi.ts like any other. The key goes in a header,
 * never in the address, and Google's own error text reaches nobody: the class of failure is all the page learns.
 *
 * FOOD_AI_MODEL may list several models, comma-separated, asked in turn: when one fails in a way the next may not (busy, over its limit,
 * too slow, unknown), the next is asked. A refused key or country is refused for every model, so it stops there.
 */
import { FoodAiError } from "./foodAiError";

/**
 * gemini-3.5-flash-lite alone. In a test of 2026-10-31 on a free key it answered 11 meals of 11 in 1 to 5 s, close to Claude and a little
 * lower on what it had to guess; gemini-3.6-flash failed 4 of 11 with 503 (busy) and took up to 30 s, and 3.8-flash was busy on every call.
 */
export const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite"];
/** How long the last model is waited for. */
export const GEMINI_TIMEOUT_MS = 45_000;
/** How long a model with another after it is waited for, so a slow one leaves time for the next. */
export const GEMINI_FIRST_TRY_MS = 20_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** What askGemini needs of fetch, so a test can hand it a fake. */
export type GeminiFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GeminiQuestion {
  /** Asked in this order, at least one. */
  models: string[];
  system: string;
  schema: unknown;
  photos: { mediaType: string; data: string }[];
  text: string;
  maxTokens: number;
}

/** What a call that was made came to: the answer, or why there is none. A call that could not be made throws a FoodAiError. */
export type GeminiReply = { stop: "ok"; answer: unknown } | { stop: "refused" | "truncated" | "unreadable"; answer: null };

/** The body of the request: the system prompt apart, one user turn with the photos first, and the answer as JSON in the schema, thinking little. */
export function geminiRequest(q: GeminiQuestion): unknown {
  return {
    systemInstruction: { parts: [{ text: q.system }] },
    contents: [{ role: "user", parts: [...q.photos.map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } })), { text: q.text }] }],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: q.schema, maxOutputTokens: q.maxTokens, thinkingConfig: { thinkingLevel: "low" } },
  };
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Why Gemini stopped without an answer to use: its safety and recitation filters are a refusal, the token limit is a truncation. */
const REFUSING = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "LANGUAGE"]);

/**
 * A call Gemini answered with an HTTP error, as the words the person sees, and whether another model may fare better (`next`): a refused
 * key or country is refused for every model. The model, the status and Google's error code go to the log.
 */
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

/** What a response body came to: the JSON text of the first candidate's parts (not its thoughts), or why there is none. */
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

/**
 * Ask Gemini one question, each model in turn until one answers; the key is GEMINI_API_KEY. A model with another after it is waited for
 * GEMINI_FIRST_TRY_MS, the last GEMINI_TIMEOUT_MS. An answer that was made is the answer, even one that cannot be used; the person sees
 * how the last model asked failed.
 */
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

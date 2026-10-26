/**
 * foodAiError.ts — why an AI estimate was refused or failed, shared by the two ways of asking Claude (the API in foodAi.ts and
 * Claude Code's `claude -p` in foodAiCli.ts). The page shows the message as it is, so it is words for the person, never the SDK's or the CLI's own.
 */

/** Why an estimate was refused: `input` (the question cannot be asked), `unconfigured` (no way to ask Claude is set up), `busy` (one is running), `limit` (the day's cap), `refused` (Claude declined), `upstream` (Claude could not answer). */
export type FoodAiErrorKind = "input" | "unconfigured" | "busy" | "limit" | "refused" | "upstream";

/** An estimate that could not be made; the message says why in words for the person. */
export class FoodAiError extends Error {
  constructor(readonly kind: FoodAiErrorKind, message: string) {
    super(message);
  }
}

export const REFUSED = "The AI declined to estimate this. Describe it another way, or enter it by hand.";
export const TRUNCATED = "The AI ran out of room before it finished. Describe fewer foods at a time.";
export const UNREADABLE = "The AI answered in a way that could not be read. Try again.";

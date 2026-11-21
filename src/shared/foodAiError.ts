
export type FoodAiErrorKind = "input" | "unconfigured" | "busy" | "limit" | "refused" | "upstream";

export class FoodAiError extends Error {
  constructor(readonly kind: FoodAiErrorKind, message: string) {
    super(message);
  }
}

export const REFUSED = "The AI declined to estimate this. Describe it another way, or enter it by hand.";
export const TRUNCATED = "The AI ran out of room before it finished. Describe fewer foods at a time.";
export const UNREADABLE = "The AI answered in a way that could not be read. Try again.";

/** Normalize a Garmin activity type key to our categories. */
export const normalizeActivityType = (rawType: string | undefined): "running" | "strength_training" | "cycling" | "swimming" | "other" => {
  const type = (rawType || "").toLowerCase();
  if (type.includes("run") || type.includes("trail")) return "running";
  if (type.includes("strength") || type.includes("weight")) return "strength_training";
  if (type.includes("cycl") || type.includes("bik")) return "cycling";
  if (type.includes("swim") || type.includes("pool")) return "swimming";
  return "other";
};

/**
 * The food log's tools: log what was eaten per meal, read it back with the totals and the calories Garmin says were burned,
 * correct an entry, delete one. They touch the database only (Garmin has nowhere to keep food), so they work without a
 * Garmin login and in mock mode. The logic is shared/nutrition.ts, which the web view uses too.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_ITEMS, MAX_RANGE_DAYS, MEALS, addFoods, averageOf, changeFood, deleteFoods, nutritionDays, totalsOf } from "../../shared/nutrition";
import { NUTRIENTS, type Nutrients, maxOf } from "../../shared/nutrients";
import { getStore } from "../../shared/store";
import { addDays, localToday } from "../../shared/wellnessSync";
import { dataProfile, runTool } from "../context";
import { isoDate, profileArg } from "./garmin";

const mealArg = z.enum(MEALS);
const grams = z.number().min(0).max(2000);
const foodFields = {
  name: z.string().min(1).max(120).describe('What was eaten, e.g. "Greek yogurt, 200 g".'),
  kcal: z.number().min(0).max(10000).optional().describe("Calories. Left out, they are worked out from the macros (4 kcal a gram of protein or carbs, 9 of fat)."),
  proteinG: grams.optional().describe("Protein in grams."),
  carbsG: grams.optional().describe("Carbohydrate in grams."),
  fatG: grams.optional().describe("Fat in grams."),
};

/**
 * The nutrients beyond the macros, one optional number each. They are the ones on a Canadian Nutrition Facts table; the unit is in the name
 * (G grams, Mg milligrams). `clearable`: a null removes the value from an entry that has one (a change), as there is no other way to say
 * "that was wrong, it is not known".
 */
const nutrientsArg = (clearable: boolean) => {
  const shape = Object.fromEntries(
    NUTRIENTS.map((def) => {
      const value = z.number().min(0).max(maxOf(def));
      return [def.key, (clearable ? value.nullable() : value).optional().describe(`${def.label} in ${def.unit === "g" ? "grams" : "milligrams"}.`)];
    })
  );
  return z
    .object(shape)
    .strict() // a misspelt key ("fibreG") is an error the assistant can read, not a nutrient quietly dropped
    .optional()
    .describe(
      clearable
        ? "Nutrients to set on the entry, by key. A key left out stays as it was; null removes that nutrient (unknown again). Never send 0 for a nutrient you do not know: 0 means none."
        : "Optional nutrients of the food for the amount eaten (fiber, sugars, saturated and trans fat, cholesterol, sodium, potassium, calcium, iron), only the ones you know or can reasonably estimate. Leave a key out when it is not known: 0 means there is none, and a day's total counts only the foods that state it."
    );
};

/** Run a nutrition tool body: a refused food is an error the assistant can read and fix. */
const run = (fn: () => unknown) => runTool(async () => fn());

export interface LogMealArgs {
  profile?: string;
  date?: string;
  meal: (typeof MEALS)[number];
  items: { name: string; kcal?: number; proteinG?: number; carbsG?: number; fatG?: number; nutrients?: Nutrients }[];
}

export function logMeal(args: LogMealArgs) {
  const store = getStore(), profile = dataProfile(args.profile), today = localToday(store, profile);
  const added = addFoods(store, profile, { day: args.date, meal: args.meal, items: args.items }, today, "mcp");
  const day = added[0].day;
  const [shown] = nutritionDays(store, profile, day, day, today);
  return {
    profile,
    date: day,
    meal: args.meal,
    added: added.map(({ id, name, kcal, proteinG, carbsG, fatG, nutrients }) => ({ id, name, kcal, proteinG, carbsG, fatG, nutrients })),
    mealTotals: shown.meals.find((m) => m.meal === args.meal)?.totals,
    dayTotals: { kcal: shown.kcal, proteinG: shown.proteinG, carbsG: shown.carbsG, fatG: shown.fatG, entries: shown.entries, nutrients: shown.nutrients },
    burnedKcal: shown.burnedKcal,
    burnedSoFar: shown.burnedSoFar,
    netKcal: shown.netKcal,
  };
}

export interface GetNutritionArgs {
  profile?: string;
  from?: string;
  to?: string;
  days: number;
}

export function getNutrition(args: GetNutritionArgs) {
  const store = getStore(), profile = dataProfile(args.profile), today = localToday(store, profile);
  const to = args.to ?? today, from = args.from ?? addDays(to, -(args.days - 1));
  const all = nutritionDays(store, profile, from, to, today);
  const logged = all.filter((d) => d.entries);
  return {
    profile,
    from,
    to,
    today,
    loggedDays: logged.length,
    unloggedDays: all.length - logged.length,
    average: averageOf(all, today),
    total: totalsOf(logged.flatMap((d) => d.meals.flatMap((m) => m.entries))),
    days: logged
      .map(({ meals, ...day }) => ({ ...day, meals: meals.filter((m) => m.entries.length).map(({ meal, totals, entries }) => ({ meal, totals, entries: entries.map(({ id, name, kcal, proteinG, carbsG, fatG, nutrients }) => ({ id, name, kcal, proteinG, carbsG, fatG, nutrients })) })) }))
      .reverse(),
  };
}

export function registerNutritionTools(server: McpServer): void {
  server.registerTool(
    "log_meal",
    {
      title: "Log food eaten",
      description:
        "Add food the person ate to their food log, for one meal (breakfast, lunch, dinner or snack) of a day (today by default). Give one item per food, each with calories and protein, carbs and fat in grams; calories left out are worked out from the macros. Add `nutrients` (fiber, sugars, saturated and trans fat, cholesterol, sodium, potassium, calcium, iron) when you know them or can estimate them from the food and portion, and leave a nutrient out when you do not: it is unknown, not zero. The person describes the food in words, so estimate the numbers from the description and the portion, say that they are estimates and ask for the portion when it matters (a bowl of rice is not a cup of rice). Prefer a few items with real names to one item per meal, so an entry can be corrected later. Returns the new entry ids, the meal and day totals so far (each nutrient total with `foods`, how many of the foods state it), and the calories Garmin says the day burned. Calling it twice adds the foods twice: if unsure whether a call went through, read get_nutrition first. Writes to the database only, never to Garmin.",
      inputSchema: {
        profile: profileArg,
        date: isoDate.optional().describe("The day eaten, YYYY-MM-DD (the user's local day). Default: today."),
        meal: mealArg,
        items: z.array(z.object({ ...foodFields, nutrients: nutrientsArg(false) })).min(1).max(MAX_ITEMS).describe("The foods of the meal."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => run(() => logMeal(args as LogMealArgs))
  );

  server.registerTool(
    "get_nutrition",
    {
      title: "Get the food log",
      description:
        "The food the person logged, per day (newest first, days with nothing logged left out and counted in `unloggedDays`): the entries of each meal with their ids, the meal and day totals (calories, protein, carbs, fat, and each nutrient beyond them that a food states, as `{ amount, foods }`: when `foods` is smaller than `entries` the amount only counts the foods that state it, so it is a lower bound, not the day's intake), the calories Garmin says the day burned and the net (eaten minus burned; today's burn is only what has burned so far, flagged by `burnedSoFar`). Also the mean of the logged days that are over (`average`) and the `total` of the range. Default: the last 7 days; at most 120. A day that was not logged is not a day of zero: do not read it as fasting. Calories and macros are estimates the person or an assistant typed in.",
      inputSchema: {
        profile: profileArg,
        from: isoDate.optional().describe("First day, YYYY-MM-DD. Default: `days` before `to`."),
        to: isoDate.optional().describe("Last day, YYYY-MM-DD. Default: today."),
        days: z.number().int().min(1).max(MAX_RANGE_DAYS).default(7).describe("How many days when `from` is not given."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => getNutrition(args))
  );

  server.registerTool(
    "update_meal_entry",
    {
      title: "Correct a food entry",
      description: "Change one food entry of the log by its id (from log_meal or get_nutrition): its name, calories, macros, nutrients, meal or day. What is left out stays as it was; calories are not worked out again from changed macros, so give them too when they should change. Returns the entry as it is now.",
      inputSchema: {
        profile: profileArg,
        id: z.number().int().positive().describe("The entry id."),
        name: foodFields.name.optional(),
        kcal: foodFields.kcal,
        proteinG: foodFields.proteinG,
        carbsG: foodFields.carbsG,
        fatG: foodFields.fatG,
        nutrients: nutrientsArg(true),
        meal: mealArg.optional(),
        date: isoDate.optional().describe("Move the entry to this day, YYYY-MM-DD."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ profile, id, date, ...patch }) =>
      run(() => {
        const name = dataProfile(profile), { product: _product, ...entry } = changeFood(getStore(), name, id, { ...patch, day: date }); // the product (per-100 g numbers) is the page's, for changing the quantity
        return { profile: name, entry };
      })
  );

  server.registerTool(
    "delete_meal_entry",
    {
      title: "Delete food entries",
      description: "Delete food entries of the log by id (from log_meal or get_nutrition), as when a call logged a food twice or the person ate something else. Ids that do not exist are listed in `missing`, not an error. Cannot be undone.",
      inputSchema: {
        profile: profileArg,
        ids: z.array(z.number().int().positive()).min(1).max(MAX_ITEMS).describe("The entry ids to delete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ profile, ids }) =>
      run(() => {
        const name = dataProfile(profile);
        return { profile: name, ...deleteFoods(getStore(), name, ids) };
      })
  );
}

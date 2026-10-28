// eslint-disable-next-line @typescript-eslint/no-var-requires
const NM = require("../web/public/nutritionModel.js");
import { MAX_PHOTOS, MAX_TEXT, MIN_TEXT } from "../shared/foodAi";
import { NUTRIENTS } from "../shared/nutrients";
import { MEALS, parseProduct, totalsOf } from "../shared/nutrition";
import { goalProgress } from "../shared/nutritionGoals";

const TODAY = "2026-10-18";
const day = (over: Record<string, unknown> = {}) => ({ day: "2026-10-17", kcal: 2000, proteinG: 150, carbsG: 200, fatG: 44, entries: 5, burnedKcal: 2500, burnedSoFar: false, netKcal: -500, ...over });

describe("saying numbers", () => {
  it("says calories, grams and a signed difference", () => {
    expect(NM.kcal(1234)).toBe(`${(1234).toLocaleString()} kcal`);
    expect(NM.kcal(null)).toBe("–");
    expect(NM.grams(30)).toBe("30 g");
    expect(NM.grams(12.5)).toBe("12.5 g");
    expect(NM.grams(undefined)).toBe("–");
    expect(NM.signed(250)).toBe("+250 kcal");
    expect(NM.signed(-300)).toBe("−300 kcal");
    expect(NM.signed(0)).toBe("0 kcal");
    expect(NM.signed(null)).toBe("–");
    expect(NM.macros({ proteinG: 30, carbsG: 45.5, fatG: 12 })).toBe("P 30 · C 45.5 · F 12");
    expect(NM.mealLabel("snack")).toBe("Snacks");
  });

  it("splits the macros by the calories they hold", () => {
    expect(NM.shares({ proteinG: 100, carbsG: 100, fatG: 0 })).toEqual({ protein: 50, carbs: 50, fat: 0 });
    expect(NM.shares({ proteinG: 30, carbsG: 45, fatG: 12 })).toEqual({ protein: 29, carbs: 44, fat: 27 });
    const s = NM.shares({ proteinG: 33, carbsG: 33, fatG: 15 });
    expect(s.protein + s.carbs + s.fat).toBe(100);
    expect(NM.shares({ proteinG: 0, carbsG: 0, fatG: 0 })).toBeNull();
  });
});

describe("the figures", () => {
  it("shows what was eaten, burned and the difference", () => {
    const [eaten, burned, net, macros] = NM.figures({ today: TODAY, day: day() });
    expect(eaten).toEqual({ label: "Eaten", value: `${(2000).toLocaleString()} kcal`, note: "5 foods" });
    expect(burned).toMatchObject({ value: `${(2500).toLocaleString()} kcal`, note: "by Garmin" });
    expect(net).toMatchObject({ value: "−500 kcal", note: "below what the day burned" });
    expect(macros.value).toBe("P 150 · C 200 · F 44");
    expect(macros.note).toMatch(/^\d+ % protein · \d+ % carbs · \d+ % fat$/);
  });

  it("says when today's burn is only so far, and when there is nothing to compare", () => {
    const [, burned, net] = NM.figures({ today: TODAY, day: day({ day: TODAY, burnedSoFar: true, netKcal: 100 }) });
    expect(burned.note).toBe("so far today, by Garmin");
    expect(net).toMatchObject({ value: "+100 kcal", note: "above what the day burned so far" });
    const [eaten, none, noNet, noMacros] = NM.figures({ today: TODAY, day: day({ entries: 0, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, burnedKcal: null, netKcal: null }) });
    expect(eaten).toMatchObject({ value: "–", note: "nothing logged" });
    expect(none).toMatchObject({ value: "–", note: "no day summary from Garmin" });
    expect(noNet).toMatchObject({ value: "–", note: "needs a logged day" });
    expect(noMacros.value).toBe("–");
    expect(NM.figures({ today: TODAY, day: day({ burnedKcal: null, netKcal: null }) })[2].note).toBe("needs the day's burn");
    expect(NM.figures({ today: TODAY, day: day({ entries: 1 }) })[0].note).toBe("1 food");
  });

  it("says the average of the logged days", () => {
    expect(NM.averageNote(null)).toBe("");
    expect(NM.averageNote({ days: 1, kcal: 2100, proteinG: 120, carbsG: 250.5, fatG: 70 })).toBe(`Average of 1 logged day: ${(2100).toLocaleString()} kcal · P 120 · C 250.5 · F 70`);
    expect(NM.averageNote({ days: 3, kcal: 1, proteinG: 1, carbsG: 1, fatG: 1 })).toMatch(/^Average of 3 logged days/);
  });
});

describe("the table and the charts", () => {
  const all = NM.GROUPS.flatMap((g: any) => g.fields);
  const by = (key: string) => all.find((f: any) => f.key === key);

  it("reads each field of a day", () => {
    expect(NM.cell(by("kcal"), day())).toBe(`${(2000).toLocaleString()} kcal`);
    expect(NM.cell(by("proteinG"), day({ proteinG: 150.5 }))).toBe("150.5 g");
    expect(NM.cell(by("burnedKcal"), day())).toBe(`${(2500).toLocaleString()} kcal`);
    expect(NM.cell(by("netKcal"), day())).toBe("−500 kcal");
  });

  it("shows a day nothing was logged on as a dash, but still says what it burned", () => {
    const empty = day({ entries: 0, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, netKcal: null });
    expect(NM.cell(by("kcal"), empty)).toBe("–");
    expect(NM.cell(by("fatG"), empty)).toBe("–");
    expect(NM.cell(by("netKcal"), empty)).toBe("–");
    expect(NM.cell(by("burnedKcal"), empty)).toBe(`${(2500).toLocaleString()} kcal`);
  });

  it("lists only fields the server sends", () => {
    const sent = [...Object.keys(day()), ...NUTRIENTS.map((n) => n.key)]; // the nutrients come as `nutrients.<key>`
    expect(all.map((f: any) => f.key).filter((k: string) => !sent.includes(k))).toEqual([]);
  });

  it("leaves the eaten numbers out of the charts for a day nothing was logged on, not as zeros", () => {
    const [logged, empty] = NM.chartDays([day(), day({ entries: 0, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 })]);
    expect(logged.kcal).toBe(2000);
    expect(empty).toMatchObject({ kcal: null, proteinG: null, carbsG: null, fatG: null, burnedKcal: 2500 });
  });

  it("draws the calories against the burn and the macros piled up", () => {
    const [eaten, macros] = NM.charts();
    expect(eaten).toMatchObject({ kind: "bars", min: 0 });
    expect(eaten.value(day())).toBe(2000);
    expect(eaten.ref.value(day())).toBe(2500);
    expect(eaten.read(day())).toBe(`${(2000).toLocaleString()} kcal · burned ${(2500).toLocaleString()}`);
    expect(eaten.read({ kcal: null, burnedKcal: 2500 })).toBe("not logged");
    expect(macros.kind).toBe("stack");
    expect(macros.parts.map((p: any) => p.key)).toEqual(["proteinG", "carbsG", "fatG"]);
    expect(macros.read(day())).toBe("P 150 · C 200 · F 44");
  });
});

describe("the form", () => {
  it("leaves empty fields out, so the server works the calories out", () => {
    expect(NM.parseDraft({ name: " Oats ", kcal: "", proteinG: "10", carbsG: "50,5", fatG: "" })).toEqual({ item: { name: "Oats", proteinG: 10, carbsG: 50.5 } });
    expect(NM.parseDraft({ name: "Beer", kcal: "150" })).toEqual({ item: { name: "Beer", kcal: 150 } });
  });

  it("sends every field when changing a food: an empty macro is 0 and empty calories are the macros' sum", () => {
    expect(NM.parseDraft({ name: "Oats", kcal: "", proteinG: "10", carbsG: "", fatG: "" }, true)).toMatchObject({ item: { name: "Oats", proteinG: 10, carbsG: 0, fatG: 0, kcal: 40 } });
    expect(NM.parseDraft({ name: "Oats", kcal: "300", proteinG: "", carbsG: "", fatG: "" }, true)).toMatchObject({ item: { name: "Oats", kcal: 300, proteinG: 0, carbsG: 0, fatG: 0 } });
  });

  it("leaves the nutrients out of a new food unless they are filled in, and sends a number as a number", () => {
    expect(NM.parseDraft({ name: "Oats", kcal: "300", fiberG: "", sodiumMg: "" }).item).toEqual({ name: "Oats", kcal: 300 });
    expect(NM.parseDraft({ name: "Oats", kcal: "300", fiberG: "8,5", sodiumMg: "0", ironMg: " 2 " }).item).toEqual({ name: "Oats", kcal: 300, nutrients: { fiberG: 8.5, sodiumMg: 0, ironMg: 2 } });
  });

  it("sends an emptied nutrient as null when changing a food, so it is removed and never becomes zero", () => {
    const { item } = NM.parseDraft({ name: "Oats", kcal: "300", fiberG: "8", sodiumMg: "", ironMg: "" }, true);
    expect(item.nutrients).toMatchObject({ fiberG: 8, sodiumMg: null, ironMg: null });
    expect(Object.values(item.nutrients).filter((v) => v === 0)).toEqual([]);
    expect(Object.keys(item.nutrients)).toEqual(NUTRIENTS.map((n) => n.key));
  });

  it("says which nutrient is wrong", () => {
    expect(NM.parseDraft({ name: "x", kcal: "10", fiberG: "lots" })).toEqual({ error: "Fiber must be a number from 0." });
    expect(NM.parseDraft({ name: "x", kcal: "10", sodiumMg: "-3" })).toEqual({ error: "Sodium must be a number from 0." });
  });

  it("says what is wrong", () => {
    expect(NM.parseDraft({ name: "", kcal: "10" })).toEqual({ error: "Give the food a name." });
    expect(NM.parseDraft({ name: "x" })).toEqual({ error: "Give the calories or at least one macro." });
    expect(NM.parseDraft({ name: "x", kcal: "-5" })).toEqual({ error: "Calories must be a number from 0." });
    expect(NM.parseDraft({ name: "x", kcal: "10", fatG: "lots" })).toEqual({ error: "Fat must be a number from 0." });
  });

  it("works the calories out as the server does, only from complete numbers", () => {
    expect(NM.kcalOf({ proteinG: "10", carbsG: "20", fatG: "3" })).toBe(147);
    expect(NM.kcalOf({ proteinG: "10", carbsG: "", fatG: "" })).toBe(40);
    expect(NM.kcalOf({ proteinG: "", carbsG: "", fatG: "" })).toBeNull();
    expect(NM.kcalOf({ proteinG: "x", carbsG: "5", fatG: "" })).toBeNull();
  });

  it("fills the form from a food, and finds a food used lately by name in any case", () => {
    const entry = { name: "Rice", kcal: 200, proteinG: 4, carbsG: 45, fatG: 0.5 };
    const noNutrients = Object.fromEntries(NUTRIENTS.map((n) => [n.key, ""]));
    expect(NM.draftOf(entry)).toEqual({ name: "Rice", kcal: "200", proteinG: "4", carbsG: "45", fatG: "0.5", ...noNutrients });
    expect(NM.EMPTY_DRAFT()).toEqual({ name: "", kcal: "", proteinG: "", carbsG: "", fatG: "", ...noNutrients });
    expect(NM.draftOf({ ...entry, nutrients: { fiberG: 3.5, sodiumMg: 0 } })).toMatchObject({ fiberG: "3.5", sodiumMg: "0", ironMg: "" }); // a stated zero is filled in as 0
    expect(NM.recentMatch([entry], " rice ")).toBe(entry);
    expect(NM.recentMatch([entry], "pasta")).toBeNull();
    expect(NM.recentMatch([entry], "")).toBeNull();
    expect(NM.recentMatch(undefined, "rice")).toBeNull();
  });
});

describe("the foods used lately", () => {
  // newest first, as the server gives them
  const recent = [
    { name: "Maple syrup · 10 ml", meal: "snack", kcal: 37, proteinG: 0, carbsG: 9.2, fatG: 0, nutrients: {} },
    { name: "OIKOS · 150 g", meal: "breakfast", kcal: 78, proteinG: 14.4, carbsG: 5.3, fatG: 0, nutrients: { calciumMg: 163 } },
    { name: "Crème brûlée", meal: "dinner", kcal: 300, proteinG: 4, carbsG: 30, fatG: 18, nutrients: {} },
    { name: "Blueberries · 50 g", meal: "breakfast", kcal: 29, proteinG: 0.4, carbsG: 7.2, fatG: 0, nutrients: { fiberG: 2.3 } },
  ];
  const names = (list: any[]) => list.map((r) => r.name);

  it("offers first the ones last logged in the meal, then the others, newest first in each", () => {
    expect(names(NM.recentFor(recent, "breakfast", ""))).toEqual(["OIKOS · 150 g", "Blueberries · 50 g", "Maple syrup · 10 ml", "Crème brûlée"]);
    expect(names(NM.recentFor(recent, "lunch", "  "))).toEqual(names(recent)); // none in this meal: plain newest first
    expect(NM.recentFor(undefined, "lunch", "")).toEqual([]);
  });

  it("keeps, with a query, the ones whose name holds every word of it, in any case and without accents", () => {
    expect(names(NM.recentFor(recent, "dinner", "oik"))).toEqual(["OIKOS · 150 g"]);
    expect(names(NM.recentFor(recent, "dinner", "creme BRULEE"))).toEqual(["Crème brûlée"]);
    expect(names(NM.recentFor(recent, "breakfast", "50 g"))).toEqual(["OIKOS · 150 g", "Blueberries · 50 g"]); // "150" holds "50"
    expect(names(NM.recentFor(recent, "breakfast", "50 blue"))).toEqual(["Blueberries · 50 g"]);
    expect(NM.recentFor(recent, "breakfast", "pizza")).toEqual([]);
  });

  it("gives a food to log again as it was logged, its nutrients a copy", () => {
    const item = NM.again(recent[1]);
    expect(item).toEqual({ name: "OIKOS · 150 g", kcal: 78, proteinG: 14.4, carbsG: 5.3, fatG: 0, nutrients: { calciumMg: 163 }, product: null });
    expect(item.nutrients).not.toBe(recent[1].nutrients);
    expect(NM.again({ name: "Old", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0 }).nutrients).toEqual({}); // a food from before the nutrients
  });

  it("counts foods in words", () => {
    expect([NM.foods(1), NM.foods(3)]).toEqual(["1 food", "3 foods"]);
  });
});

describe("barcodes", () => {
  it("checks the digit a barcode ends with", () => {
    for (const ok of ["3017620422003", "894700010137", "0894700010137", "96385074", "40170725"]) expect(NM.gtinOk(ok)).toBe(true);
    for (const bad of ["3017620422004", "894700010138", "12345678", "1234", "abc", "", "301762042200"]) expect(NM.gtinOk(bad)).toBe(false);
  });

  it("expands a UPC-E to the UPC-A it stands for", () => {
    expect(NM.expandUpcE("04252614")).toBe("042100005264"); // the Wikipedia example
    expect(NM.expandUpcE("04252615")).toBeNull();
    expect(NM.expandUpcE("23456789")).toBeNull(); // number system must be 0 or 1
    expect(NM.expandUpcE("0425261")).toBeNull();
  });

  it("accepts what a reader or a person gives only when it is a real barcode", () => {
    expect(NM.normalizeBarcode("3017620422003")).toBe("3017620422003");
    expect(NM.normalizeBarcode(" 3017 6204 22003 ")).toBe("3017620422003");
    expect(NM.normalizeBarcode("3017-6204-22003")).toBe("3017620422003");
    expect(NM.normalizeBarcode("04252614")).toBe("042100005264"); // UPC-E, looked up as the UPC-A
    expect(NM.normalizeBarcode("96385074")).toBe("96385074");
    for (const no of ["3017620422004", "1234567", "greek yogurt", "", null, undefined, "123456789012345"]) expect(NM.normalizeBarcode(no)).toBeNull();
  });
});

describe("a food by quantity", () => {
  const yogurt = { name: "Greek Yogurt", brand: "chobani", per100: { kcal: 52.9, proteinG: 9.5, carbsG: 4, fatG: 0 }, unit: "g", servingG: 170 };
  const juice = { name: "Orange juice", brand: null, per100: { kcal: 45, proteinG: 0.7, carbsG: 10, fatG: 0.2 }, unit: "ml", servingG: null };

  it("works the calories and macros out for the grams eaten", () => {
    expect(NM.scale(yogurt.per100, 170)).toEqual({ kcal: 90, proteinG: 16.2, carbsG: 6.8, fatG: 0 });
    expect(NM.scale(yogurt.per100, 100)).toEqual({ kcal: 53, proteinG: 9.5, carbsG: 4, fatG: 0 });
    expect(NM.scale(yogurt.per100, 0)).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it("counts portions as the product's portion size, and has none when it states no size", () => {
    expect(NM.amountGrams(yogurt, 2, "portion")).toBe(340);
    expect(NM.amountGrams(yogurt, 150, "g")).toBe(150);
    expect(NM.amountGrams(juice, 2, "portion")).toBe(2);
  });

  it("says what the quantity comes to, and the name to log it under", () => {
    expect(NM.portion(yogurt, "1", "portion")).toEqual({
      amount: 1, grams: 170, nutrition: { kcal: 90, proteinG: 16.2, carbsG: 6.8, fatG: 0 }, nutrients: {}, name: "Greek Yogurt (chobani) · 1 × 170 g",
      // what is kept with the food, so it can be changed by quantity later
      product: { code: null, name: "Greek Yogurt", brand: "chobani", unit: "g", per100: yogurt.per100, nutrients: {}, servingG: 170, servingText: null, amount: 1, per: "portion" },
    });
    expect(NM.portion(yogurt, "1,5", "portion")).toMatchObject({ grams: 255, name: "Greek Yogurt (chobani) · 1.5 × 170 g" });
    expect(NM.portion(yogurt, "250", "g")).toMatchObject({ grams: 250, name: "Greek Yogurt (chobani) · 250 g" });
    expect(NM.portion(juice, "330", "g")).toMatchObject({ nutrition: { kcal: 149 }, name: "Orange juice · 330 ml" });
  });

  it("gives a food logged from a product back to the picker, to change its quantity", () => {
    const logged = NM.portion({ ...yogurt, code: "0056800202458", nutrients: { calciumMg: 110 } }, "1.5", "portion");
    const entry = { name: logged.name, ...logged.nutrition, nutrients: logged.nutrients, product: logged.product };
    const back = NM.pickOf(NM.productOf(entry));
    expect(back).toMatchObject({ amount: "1.5", unit: "portion", food: { code: "0056800202458", name: "Greek Yogurt", servingG: 170 } });
    expect(NM.portion(back.food, back.amount, back.unit)).toEqual(logged); // as it was
    expect(NM.portion(back.food, "200", "g")).toMatchObject({ name: "Greek Yogurt (chobani) · 200 g", nutrition: { kcal: 106, proteinG: 19 }, nutrients: { calciumMg: 220 }, product: { amount: 200, per: "g" } });
  });

  it("works the product out for a food logged before products were kept, from its numbers and the quantity its name ends with", () => {
    const chia = { name: "Black Chia Seeds (Yupik) · 1 × 15 g", kcal: 70, proteinG: 2, carbsG: 6, fatG: 4.5, nutrients: { fiberG: 5.1 }, product: null };
    const p = NM.productOf(chia);
    expect(p).toEqual({ code: null, name: "Black Chia Seeds (Yupik)", brand: null, unit: "g", per100: { kcal: 466.67, proteinG: 13.33, carbsG: 40, fatG: 30 }, nutrients: { fiberG: 34 }, servingG: 15, servingText: null, amount: 1, per: "portion" });
    const back = NM.pickOf(p);
    expect(NM.portion(back.food, back.amount, back.unit)).toMatchObject({ name: chia.name, nutrition: { kcal: 70, proteinG: 2, carbsG: 6, fatG: 4.5 }, nutrients: { fiberG: 5.1 } }); // exact at the quantity logged
    expect(NM.portion(back.food, "30", "g")).toMatchObject({ name: "Black Chia Seeds (Yupik) · 30 g", nutrition: { kcal: 140, fatG: 9 } });
    expect(NM.productOf({ name: "Milk · 75 ml", kcal: 48, proteinG: 5.4, carbsG: 2.7, fatG: 1.5 })).toMatchObject({ name: "Milk", unit: "ml", amount: 75, per: "g", per100: { kcal: 64 }, nutrients: {} });
    // a food typed in or estimated has no quantity to change
    for (const name of ["Banana", "Rice 150 g", " · 50 g", "Rice · 0 g"]) expect(NM.productOf({ name, kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 })).toBeNull();
  });

  it("sends every nutrient when a food is changed, null for the ones it does not state", () => {
    const all = NM.allNutrients({ fiberG: 3, ironMg: 0 });
    expect(Object.keys(all)).toEqual(NM.NUTRIENTS.map((n: { key: string }) => n.key));
    expect(all).toMatchObject({ fiberG: 3, ironMg: 0, sodiumMg: null });
  });

  it("refuses a quantity that is not a number, is not above 0 or is more than a person eats", () => {
    for (const bad of ["", "abc", "0", "-5", "2001", null]) expect(NM.portion(yogurt, bad, "g")).toBeNull();
    expect(NM.portion(yogurt, "2000", "g")).not.toBeNull();
    expect(NM.portion(yogurt, "12", "portion")).toBeNull(); // 2040 g
    expect(NM.parseAmount("1e2")).toBe(100);
  });

  it("keeps the logged name within 120 characters, whatever the product is called", () => {
    const long = { ...yogurt, name: "x".repeat(100), brand: "y".repeat(40) };
    const name = NM.entryName(long, 170, "g");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/…\s·\s170 g$|…\) · 170 g$/);
    expect(name.endsWith(" · 170 g")).toBe(true);
  });

  it("leaves the brand out when the name has it already", () => {
    const nutella = { name: "Nutella", brand: "Nutella", per100: yogurt.per100, unit: "g", servingG: null };
    expect(NM.brandOf(nutella)).toBe("");
    expect(NM.entryName(nutella, 30, "g")).toBe("Nutella · 30 g");
    expect(NM.foodTitle({ ...nutella, name: "Hazelnut spread", brand: "Nutella" })).toBe("Hazelnut spread · Nutella");
    expect(NM.brandOf({ ...nutella, name: "Nutella B-ready", brand: "nutella" })).toBe("");
    expect(NM.brandOf(yogurt)).toBe("chobani");
    expect(NM.brandOf(juice)).toBe("");
  });

  it("lists a food as the results show it", () => {
    expect(NM.per100Line(yogurt)).toBe("53 kcal · P 9.5 · C 4 · F 0 per 100 g");
    expect(NM.per100Line(juice)).toBe("45 kcal · P 0.7 · C 10 · F 0.2 per 100 ml");
    expect(NM.foodTitle(yogurt)).toBe("Greek Yogurt · chobani");
    expect(NM.foodTitle(juice)).toBe("Orange juice");
  });
});

describe("the nutrients beyond the macros", () => {
  it("are the server's list, in the same order and units", () => {
    expect(NM.NUTRIENTS).toEqual(NUTRIENTS.map(({ key, label, unit }) => ({ key, label, unit })));
  });

  it("scale with the quantity eaten, and a nutrient the food does not state stays unknown", () => {
    const food = { code: "1", name: "Kraft Dinner", brand: "Kraft", per100: { kcal: 360, proteinG: 13, carbsG: 72, fatG: 2.5 }, nutrients: { fiberG: 2.35, sodiumMg: 660, ironMg: 3 }, unit: "g", servingG: null };
    const r = NM.portion(food, "85", "g");
    expect(r.nutrients).toEqual({ fiberG: 2, sodiumMg: 561, ironMg: 2.6 });
    expect(r.nutrients).not.toHaveProperty("calciumMg");
    expect(NM.portion({ ...food, nutrients: undefined }, "100", "g").nutrients).toEqual({}); // a food kept before they were read
    expect(NM.scaleNutrients({ fiberG: 0 }, 50)).toEqual({ fiberG: 0 }); // a stated zero stays a value
  });

  it("read as a line for an entry: the stated ones, in the list's order", () => {
    expect(NM.nutrientLine({ sodiumMg: 410, fiberG: 3, ironMg: 1.5 })).toBe("Fiber 3 g · Sodium 410 mg · Iron 1.5 mg");
    expect(NM.nutrientLine({})).toBe("");
    expect(NM.nutrientLine(undefined)).toBe("");
    expect(NM.nutrientLine({ transFatG: 0 })).toBe("Trans fat 0 g");
    expect(NM.nutrientLine({ calciumMg: 212.5, ironMg: 5.1, sodiumMg: 1122.4, fiberG: 12.5 })).toBe(`Fiber 12.5 g · Sodium ${(1122).toLocaleString()} mg · Calcium 213 mg · Iron 5.1 mg`); // grams keep their decimal, milligrams from 10 up are whole
  });

  it("make a tile each for a day: a dash for one no food states, and a lower bound when some foods leave it out", () => {
    const tiles = NM.nutrientTiles(day({ entries: 3, nutrients: { fiberG: { amount: 18.2, foods: 2 }, sodiumMg: { amount: 2100, foods: 3 } } }));
    expect(tiles.map((t: any) => t.label)).toEqual(NUTRIENTS.map((n) => n.label));
    expect(tiles[0]).toEqual({ key: "fiberG", label: "Fiber", value: "≥ 18.2 g", note: "from 2 of 3 foods", partial: true });
    expect(tiles.find((t: any) => t.key === "sodiumMg")).toMatchObject({ value: `${(2100).toLocaleString()} mg`, note: "from all 3 foods", partial: false });
    expect(tiles.find((t: any) => t.key === "ironMg")).toMatchObject({ value: "–", note: "no food states it", partial: false });
    expect(NM.nutrientTiles(day({ entries: 1, nutrients: { fiberG: { amount: 3, foods: 1 } } }))[0].note).toBe("from the food");
  });

  it("have no tiles for a day nothing was logged on", () => {
    expect(NM.nutrientTiles(day({ entries: 0, nutrients: {} }))).toEqual([]);
    expect(NM.nutrientTiles(null)).toEqual([]);
  });

  it("fill their own group of the daily table, a lower bound reading with ≥ and a day with none a dash", () => {
    const group = NM.GROUPS.find((g: any) => g.name === "Nutrients");
    expect(group.fields.map((f: any) => f.key)).toEqual(NUTRIENTS.map((n) => n.key));
    const fiber = group.fields[0], sodium = group.fields[5];
    const d = day({ entries: 3, nutrients: { fiberG: { amount: 18.2, foods: 2 }, sodiumMg: { amount: 2100, foods: 3 } } });
    expect(NM.cell(fiber, d)).toBe("≥ 18.2 g");
    expect(NM.cell(sodium, d)).toBe(`${(2100).toLocaleString()} mg`);
    expect(NM.cell(group.fields[8], d)).toBe("–");
    expect(NM.cell(fiber, day({ entries: 0, nutrients: {} }))).toBe("–");
    expect(NM.cell(fiber, day())).toBe("–"); // a day from a server that sends none
  });

  it("tell the form whether the person has typed any number, and whether any is a nutrient", () => {
    expect(NM.hasNumbers(NM.EMPTY_DRAFT())).toBe(false);
    expect(NM.hasNumbers({ ...NM.EMPTY_DRAFT(), kcal: "100" })).toBe(true);
    expect(NM.hasNumbers({ ...NM.EMPTY_DRAFT(), ironMg: "0" })).toBe(true);
    expect(NM.hasNutrients({ ...NM.EMPTY_DRAFT(), kcal: "100" })).toBe(false);
    expect(NM.hasNutrients({ ...NM.EMPTY_DRAFT(), fiberG: "3" })).toBe(true);
  });
});

describe("foods estimated by AI", () => {
  const eggs = { name: "Scrambled eggs", portion: "2 large eggs", meal: "breakfast", amount: 100, unit: "g", kcal: 190, proteinG: 13, carbsG: 1.6, fatG: 14, nutrients: { cholesterolMg: 370, sodiumMg: 170 } };
  const milk = { name: "Milk 2 %", portion: "1 glass", meal: "snack", amount: 250, unit: "ml", kcal: 125, proteinG: 8.5, carbsG: 12, fatG: 5, nutrients: { calciumMg: 300 } };
  const salt = { name: "Salt", portion: "1 pinch", meal: "dinner", amount: 1, unit: "g", kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, nutrients: { sodiumMg: 600 } };

  it("limits a question as the server does", () => {
    expect(NM.AI_LIMITS).toEqual({ minText: MIN_TEXT, maxText: MAX_TEXT, maxPhotos: MAX_PHOTOS });
  });

  it("guesses the meal from the hour, a snack at night and when the hour is no number", () => {
    expect([0, 3, 4, 9, 10, 13, 14, 16, 17, 21, 22, 23].map(NM.mealForHour)).toEqual(["snack", "snack", "breakfast", "breakfast", "lunch", "lunch", "snack", "snack", "dinner", "dinner", "snack", "snack"]);
    expect(NM.mealForHour(undefined)).toBe("snack");
    expect(NM.mealForHour("x")).toBe("snack");
    expect(MEALS).toEqual(expect.arrayContaining(NM.aiGroups(["breakfast", "lunch", "dinner", "snack"].map((meal) => ({ meal }))).map((g: any) => g.meal)));
  });

  it("can estimate from a few words or a photo alone, not from two characters, nothing or too much", () => {
    expect(NM.canEstimate("two eggs", 0)).toBe(true);
    expect(NM.canEstimate("  abc  ", 0)).toBe(true);
    expect(NM.canEstimate("ab", 0)).toBe(false);
    expect(NM.canEstimate("", 0)).toBe(false);
    expect(NM.canEstimate(null, 0)).toBe(false);
    expect(NM.canEstimate("", 1)).toBe(true);
    expect(NM.canEstimate("   ", 2)).toBe(true);
    expect(NM.canEstimate("ab", 1)).toBe(false); // the server refuses it
    expect(NM.canEstimate("x".repeat(MAX_TEXT), 0)).toBe(true);
    expect(NM.canEstimate("x".repeat(MAX_TEXT + 1), 1)).toBe(false);
  });

  it("turns the amount eaten into a food per 100 g, so the grams box works like the one for a scanned food", () => {
    const food = NM.aiFood(eggs);
    expect(food).toMatchObject({ name: "Scrambled eggs", brand: null, code: null, unit: "g", per100: { kcal: 190, proteinG: 13, carbsG: 1.6, fatG: 14 }, nutrients: { cholesterolMg: 370, sodiumMg: 170 }, servingG: null });
    const m = NM.aiFood(milk);
    expect(m.unit).toBe("ml");
    expect(m.per100.kcal).toBe(50);
    expect(m.nutrients).toEqual({ calciumMg: 120 });
  });

  it("keeps a nutrient it was not given unknown, and a stated zero zero", () => {
    expect(NM.aiFood({ ...eggs, nutrients: {} }).nutrients).toEqual({});
    expect(NM.aiFood({ ...eggs, nutrients: { fiberG: 0, ironMg: null } }).nutrients).toEqual({ fiberG: 0 });
  });

  it("logs the food at the amount estimated as the numbers estimated, and rescales it for another amount", () => {
    const row = NM.aiRows([eggs])[0];
    expect(row).toMatchObject({ amount: "100", meal: "breakfast" });
    const v = NM.aiRowValue(row);
    expect(v).toMatchObject({ grams: 100, nutrition: { kcal: 190, proteinG: 13, carbsG: 1.6, fatG: 14 }, nutrients: { cholesterolMg: 370, sodiumMg: 170 }, name: "Scrambled eggs · 100 g" });
    expect(v.product).toMatchObject({ name: "Scrambled eggs", unit: "g", amount: 100, per: "g", per100: { kcal: 190 } });
    const more = NM.aiRowValue({ ...row, amount: "150" });
    expect(more).toMatchObject({ nutrition: { kcal: 285, proteinG: 19.5, fatG: 21 }, nutrients: { cholesterolMg: 555 }, name: "Scrambled eggs · 150 g" });
    expect(NM.aiRowValue({ ...NM.aiRows([milk])[0], amount: "200" })).toMatchObject({ nutrition: { kcal: 100 }, name: "Milk 2 % · 200 ml" });
  });

  it("makes a product the server accepts, and scales back to the estimate within rounding for an awkward amount", () => {
    const odd = { ...eggs, amount: 37, kcal: 80, proteinG: 5.3, carbsG: 0.6, fatG: 6.1, nutrients: { sodiumMg: 63 } };
    const v = NM.aiRowValue(NM.aiRows([odd])[0]);
    expect(() => parseProduct(v.product)).not.toThrow();
    expect(v.nutrition.kcal).toBe(80);
    expect(Math.abs(v.nutrition.proteinG - 5.3)).toBeLessThanOrEqual(0.1);
    for (const item of [eggs, milk]) expect(() => parseProduct(NM.aiRowValue(NM.aiRows([item])[0]).product)).not.toThrow();
  });

  it("keeps the numbers as estimated, with no product, for a food that cannot be per 100 g", () => {
    expect(NM.aiFood(salt)).toBeNull(); // 600 mg in 1 g is more sodium than salt holds per 100 g (at most 40 %)
    expect(NM.aiFood({ ...salt, nutrients: { sodiumMg: 390 } })).not.toBeNull();
    expect(NM.aiFood({ ...eggs, kcal: 2000 })).toBeNull(); // 2000 kcal in 100 g
    expect(NM.aiFood({ ...eggs, amount: 0 })).toBeNull();
    expect(NM.aiFood({ ...eggs, kcal: undefined })).toBeNull();
    const v = NM.aiRowValue(NM.aiRows([salt])[0]);
    expect(v).toMatchObject({ grams: 1, nutrition: { kcal: 0 }, nutrients: { sodiumMg: 600 }, name: "Salt · 1 g", product: null });
  });

  it("has no value for an amount that is no number, zero or too much", () => {
    const row = NM.aiRows([eggs])[0];
    for (const amount of ["", "0", "-1", "lots", "2001"]) expect(NM.aiRowValue({ ...row, amount })).toBeNull();
    expect(NM.aiRowValue({ ...row, amount: "2000" })).not.toBeNull();
    expect(NM.aiRowValue({ ...row, amount: "1,5" })).not.toBeNull(); // a comma is read as the decimal point
  });

  it("groups the rows by meal in the day's order, and sums the kept ones", () => {
    const rows = NM.aiRows([milk, eggs, { ...eggs, name: "Bacon", meal: "breakfast", amount: 30, kcal: 130, proteinG: 9, carbsG: 0.3, fatG: 10, nutrients: {} }]);
    expect(NM.aiGroups(rows).map((g: any) => [g.meal, g.rows.map((r: any) => r.item.name)])).toEqual([["breakfast", ["Scrambled eggs", "Bacon"]], ["snack", ["Milk 2 %"]]]);
    rows[1].meal = "lunch";
    expect(NM.aiGroups(rows).map((g: any) => g.meal)).toEqual(["breakfast", "lunch", "snack"]);
    expect(NM.aiTotals(rows)).toEqual({ kcal: 445, proteinG: 30.5, carbsG: 13.9, fatG: 29 });
    expect(NM.aiTotals(rows.slice(0, 1))).toEqual({ kcal: 125, proteinG: 8.5, carbsG: 12, fatG: 5 });
    expect(NM.aiTotals([{ ...rows[0], amount: "0" }, rows[1]])).toMatchObject({ kcal: 190 }); // a row with no good amount adds nothing
    expect(NM.aiTotals([])).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it("says the total as an estimate", () => {
    expect(NM.approx({ kcal: 306, proteinG: 15, carbsG: 16.4, fatG: 21 })).toBe(`≈ ${NM.kcal(306)} · P 15 · C 16.4 · F 21`);
  });

  it("makes the foods to send, each with its meal, nutrients and product, or says what stops it", () => {
    const rows = NM.aiRows([eggs, milk, salt]);
    const sent = NM.aiItems(rows);
    expect(sent.error).toBeUndefined();
    expect(sent.items.map((i: any) => [i.name, i.meal, i.kcal])).toEqual([["Scrambled eggs · 100 g", "breakfast", 190], ["Milk 2 % · 250 ml", "snack", 125], ["Salt · 1 g", "dinner", 0]]);
    expect(sent.items[0]).toMatchObject({ proteinG: 13, nutrients: { cholesterolMg: 370, sodiumMg: 170 }, product: expect.objectContaining({ amount: 100 }) });
    expect(sent.items[2].product).toBeNull();
    expect(NM.aiItems([])).toEqual({ error: "There is nothing to log." });
    expect(NM.aiItems([{ ...rows[0], amount: "0" }, rows[1]]).error).toMatch(/Give Scrambled eggs an amount above 0/);
  });
});

// ── The daily goals ──────────────────────────────────────────────────────

/** A view as the server sends it: the day with its meals, the goals and where the day stands against them (the real goalProgress). */
function goalView(foods: Record<string, any>[], goals: Record<string, number>, extra: Record<string, unknown> = {}) {
  const entry = (f: Record<string, any>) => ({ meal: "lunch", name: "x", kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, nutrients: {}, ...f });
  const entries = foods.map(entry);
  const meals = MEALS.map((meal) => {
    const mine = entries.filter((e) => e.meal === meal);
    return { meal, entries: mine, totals: totalsOf(mine as any) };
  });
  const totals = totalsOf(entries as any);
  const dayOfView = { day: TODAY, ...totals, burnedKcal: null, burnedSoFar: false, netKcal: null, meals };
  return { today: TODAY, date: TODAY, day: dayOfView, goals, progress: goalProgress(goals, totals), ...extra };
}

describe("saying where a goal stands", () => {
  const view = goalView([{ kcal: 500, proteinG: 40, carbsG: 50, fatG: 10, nutrients: { sodiumMg: 800, fiberG: 4 } }, { kcal: 300, proteinG: 20 }], { kcal: 2000, proteinG: 100, carbsG: 250, sodiumMg: 700, fiberG: 30 });
  const by = (key: string) => view.progress.find((p: any) => p.key === key);

  it("words the amount against the goal and what is left", () => {
    expect(NM.goalValue(by("kcal"))).toBe(`${(800).toLocaleString()} / ${(2000).toLocaleString()} kcal`);
    expect(NM.goalNote(by("kcal"), 2)).toBe(`${(1200).toLocaleString()} kcal to go`);
    expect(NM.goalValue(by("proteinG"))).toBe("60 / 100 g");
    expect(NM.goalNote(by("proteinG"), 2)).toBe("40 g to go");
    expect(NM.qty(2300, "mg")).toBe(`${(2300).toLocaleString()} mg`);
    expect(NM.qty(12.5, "g")).toBe("12.5 g");
  });

  it("says a ceiling that was passed as over, with a mark that is not only colour", () => {
    expect(by("sodiumMg")).toMatchObject({ state: "over", partial: true });
    expect(NM.goalNote(by("sodiumMg"), 2)).toBe("▲ over by at least 100 mg"); // from some of the foods: at least
    expect(NM.goalValue(by("sodiumMg"))).toBe("≥ 800 / 700 mg");
  });

  it("says a floor from some of the foods as a limit, and a goal reached or on target with a check", () => {
    expect(NM.goalNote(by("fiberG"), 2)).toBe("up to 26 g to go");
    const full = goalView([{ kcal: 1000, proteinG: 120, nutrients: { sodiumMg: 500, fiberG: 35 } }], { kcal: 1000, proteinG: 100, sodiumMg: 700, fiberG: 30 });
    const note = (key: string) => NM.goalNote(full.progress.find((p: any) => p.key === key), 1);
    expect(note("proteinG")).toBe("✓ reached");
    expect(note("kcal")).toBe("✓ on target");
    expect(note("sodiumMg")).toBe("200 mg left");
    expect(note("fiberG")).toBe("✓ reached");
  });

  it("says nothing is logged, or that no food states a nutrient, never zero", () => {
    const empty = goalView([], { kcal: 2000, sodiumMg: 2300 });
    expect(empty.progress.map((p: any) => NM.goalNote(p, 0))).toEqual(["nothing logged", "nothing logged"]);
    expect(NM.goalValue(empty.progress[0])).toBe(`– / ${(2000).toLocaleString()} kcal`);
    const none = goalView([{ kcal: 100 }], { sodiumMg: 2300 });
    expect(NM.goalNote(none.progress[0], 1)).toBe("no food states it");
    expect(NM.goalMeter(none.progress[0])).toBeNull();
  });

  it("sizes a bar to the goal, and puts the goal on it once the amount is past it", () => {
    expect(NM.goalMeter(by("proteinG"))).toEqual({ fill: 60, tick: null });
    expect(NM.goalMeter(by("sodiumMg"))).toEqual({ fill: 100, tick: (700 / 800) * 100 });
  });

  it("names what a goal is", () => {
    expect([NM.kindLabel("min"), NM.kindLabel("max"), NM.kindLabel("target"), NM.kindLabel("nope")]).toEqual(["at least", "at most", "the aim", ""]);
  });
});

describe("the summary of the day", () => {
  const foods = [{ meal: "breakfast", kcal: 400, proteinG: 20, carbsG: 50, fatG: 13 }, { meal: "dinner", kcal: 600, proteinG: 40, carbsG: 40, fatG: 20 }];

  it("leads with what was eaten and where it stands against the calorie goal", () => {
    const v = goalView(foods, { kcal: 2000, proteinG: 150 });
    expect(NM.headline(v)).toEqual({ value: (1000).toLocaleString(), unit: "kcal eaten", note: `${(1000).toLocaleString()} kcal to go · goal ${(2000).toLocaleString()} kcal`, state: "short" });
    expect(NM.headline(goalView(foods, {}))).toMatchObject({ note: "2 foods", state: "none" });
    expect(NM.headline(goalView([], { kcal: 2000 }))).toMatchObject({ value: "–", note: `goal ${(2000).toLocaleString()} kcal · nothing logged`, state: "unknown" });
    expect(NM.headline(goalView([], {}))).toMatchObject({ value: "–", note: "nothing logged" });
  });

  it("splits the calorie bar into protein, carbs and fat, as long as the day is of the goal", () => {
    const bar = NM.calorieBar(goalView(foods, { kcal: 2000 }).day, 2000);
    expect(bar.segments.map((x: any) => x.cls)).toEqual(["protein", "carbs", "fat"]);
    expect(bar.segments.reduce((t: number, x: any) => t + x.width, 0)).toBeCloseTo(50, 5); // 1000 of 2000 kcal
    expect(bar.tick).toBeNull();
    const over = NM.calorieBar(goalView(foods, { kcal: 800 }).day, 800);
    expect(over.segments.reduce((t: number, x: any) => t + x.width, 0)).toBeCloseTo(100, 5);
    expect(over.tick).toBeCloseTo(80, 5); // the goal is 800 of the 1000 eaten
    expect(NM.calorieBar(goalView(foods, {}).day, undefined).segments.reduce((t: number, x: any) => t + x.width, 0)).toBeCloseTo(100, 5);
    expect(NM.calorieBar(goalView([], { kcal: 2000 }).day, 2000)).toBeNull();
  });

  it("draws a day that states calories but no macros as one plain segment", () => {
    const bar = NM.calorieBar(goalView([{ kcal: 500 }], { kcal: 1000 }).day, 1000);
    expect(bar.segments).toEqual([expect.objectContaining({ cls: "kcal", width: 50 })]);
  });

  it("gives a bar to each macro that has a goal, and just the grams to one that has not", () => {
    const rows = NM.macroRows(goalView(foods, { proteinG: 120 }));
    expect(rows.map((r: any) => r.key)).toEqual(["proteinG", "carbsG", "fatG"]);
    expect(rows[0]).toMatchObject({ value: "60 / 120 g", note: "60 g to go", cls: "protein", state: "short", meter: { fill: 50, tick: null } });
    expect(rows[1]).toMatchObject({ value: "90 g", note: "", meter: null, state: "none" });
    expect(NM.macroRows(goalView([], {}))[0]).toMatchObject({ value: "–", meter: null });
  });

  it("says the burn and the difference when there is a burn", () => {
    const v = goalView(foods, { kcal: 2000 });
    expect(NM.burnLine(v)).toBe("");
    const burned = { ...v, day: { ...v.day, burnedKcal: 1209, netKcal: -209 } };
    expect(NM.burnLine(burned)).toBe(`Burned ${(1209).toLocaleString()} kcal so far by Garmin · eaten − burned −209 kcal`);
    expect(NM.burnLine({ ...burned, date: "2026-10-17", day: { ...burned.day, day: "2026-10-17" } })).toMatch(/^Burned .* by Garmin/);
    expect(NM.burnLine({ ...burned, burn: false })).toBe("");
  });

  it("gives the Today view's Eaten tile the goal", () => {
    const v = goalView(foods, { kcal: 2000 });
    expect(NM.figures({ today: TODAY, day: v.day, progress: v.progress })[0]).toMatchObject({ label: "Eaten", note: `of ${(2000).toLocaleString()} · ${(1000).toLocaleString()} kcal to go` });
    expect(NM.figures({ today: TODAY, day: v.day })[0].note).toBe("2 foods");
  });
});

describe("the breakdown", () => {
  const foods = [{ meal: "breakfast", kcal: 400, proteinG: 20, carbsG: 50, fatG: 13, nutrients: { fiberG: 5 } }, { meal: "dinner", kcal: 800, proteinG: 40, carbsG: 40, fatG: 20, nutrients: { fiberG: 3, sodiumMg: 900 } }];

  it("draws a bar per meal as long as its calories against the largest meal, split by macro", () => {
    const bars = NM.mealBars(goalView(foods, { kcal: 2400 }));
    expect(bars.map((b: any) => [b.meal, b.logged])).toEqual([["breakfast", true], ["lunch", false], ["dinner", true], ["snack", false]]);
    expect(bars[2].width).toBe(100);
    expect(bars[0].width).toBe(50);
    expect(bars[0].segments.map((x: any) => x.cls)).toEqual(["protein", "carbs", "fat"]);
    expect(bars[0].segments.reduce((t: number, x: any) => t + x.width, 0)).toBeCloseTo(100, 5);
    expect(bars[0]).toMatchObject({ value: "400 kcal", share: 17, shareOf: "of the goal", note: "P 20 · C 50 · F 13" });
    expect(bars[1]).toMatchObject({ value: "–", note: "nothing logged", width: 0, segments: [], share: null });
  });

  it("measures a meal against the day without a calorie goal", () => {
    expect(NM.mealBars(goalView(foods, {}))[0]).toMatchObject({ share: 33, shareOf: "of the day" });
  });

  it("lists the nutrients with a goal first, as bars, then the others as the tiles said them", () => {
    const rows = NM.nutrientRows(goalView(foods, { sodiumMg: 2300, fiberG: 30 }));
    expect(rows.map((r: any) => r.key)).toEqual(["fiberG", "sodiumMg", "sugarsG", "satFatG", "transFatG", "cholesterolMg", "potassiumMg", "calciumMg", "ironMg"]);
    expect(rows[0]).toMatchObject({ goal: true, value: "8 / 30 g", note: "22 g to go", meter: { fill: (8 / 30) * 100, tick: null } });
    expect(rows[1]).toMatchObject({ goal: true, value: "≥ 900 / 2,300 mg".replace("2,300", (2300).toLocaleString()), partial: true, note: `up to ${(1400).toLocaleString()} mg left` });
    expect(rows[2]).toMatchObject({ goal: false, meter: null, value: "–", note: "no food states it" });
  });

  it("lists only the goals for a day nothing was logged on, and nothing without goals", () => {
    expect(NM.nutrientRows(goalView([], { sodiumMg: 2300 })).map((r: any) => [r.key, r.note])).toEqual([["sodiumMg", "nothing logged"]]);
    expect(NM.nutrientRows(goalView([], {}))).toEqual([]);
  });
});

describe("the charts with goals", () => {
  it("puts the calorie goal on the calories chart and adds a protein chart when there is a protein goal", () => {
    const [eaten, macros, protein, ...more] = NM.charts({ burn: true, goals: { kcal: 2200, proteinG: 140 } });
    expect(eaten.goal).toEqual({ label: `Goal ${(2200).toLocaleString()} kcal`, value: 2200 });
    expect(macros.goal).toBeUndefined();
    expect(protein).toMatchObject({ id: "protein", kind: "bars", goal: { label: "Goal 140 g", value: 140 } });
    expect(protein.value(day())).toBe(150);
    expect(protein.read(day())).toBe("150 g · 107 % of the goal");
    expect(protein.read({ proteinG: null })).toBe("not logged");
    expect(more).toEqual([]);
  });

  it("draws no goal line and no protein chart without goals", () => {
    const charts = NM.charts({ burn: true, goals: {} });
    expect(charts.map((c: any) => c.id)).toEqual(["eaten", "macros"]);
    expect(charts[0].goal).toBeUndefined();
  });
});

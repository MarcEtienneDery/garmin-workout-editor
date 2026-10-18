// eslint-disable-next-line @typescript-eslint/no-var-requires
const NM = require("../web/public/nutritionModel.js");

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
    expect(all.map((f: any) => f.key).filter((k: string) => !Object.keys(day()).includes(k))).toEqual([]);
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
    expect(NM.parseDraft({ name: "Oats", kcal: "", proteinG: "10", carbsG: "", fatG: "" }, true)).toEqual({ item: { name: "Oats", proteinG: 10, carbsG: 0, fatG: 0, kcal: 40 } });
    expect(NM.parseDraft({ name: "Oats", kcal: "300", proteinG: "", carbsG: "", fatG: "" }, true)).toEqual({ item: { name: "Oats", kcal: 300, proteinG: 0, carbsG: 0, fatG: 0 } });
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
    expect(NM.draftOf(entry)).toEqual({ name: "Rice", kcal: "200", proteinG: "4", carbsG: "45", fatG: "0.5" });
    expect(NM.EMPTY_DRAFT()).toEqual({ name: "", kcal: "", proteinG: "", carbsG: "", fatG: "" });
    expect(NM.recentMatch([entry], " rice ")).toBe(entry);
    expect(NM.recentMatch([entry], "pasta")).toBeNull();
    expect(NM.recentMatch([entry], "")).toBeNull();
    expect(NM.recentMatch(undefined, "rice")).toBeNull();
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
    expect(NM.portion(yogurt, "1", "portion")).toEqual({ amount: 1, grams: 170, nutrition: { kcal: 90, proteinG: 16.2, carbsG: 6.8, fatG: 0 }, name: "Greek Yogurt (chobani) · 1 × 170 g" });
    expect(NM.portion(yogurt, "1,5", "portion")).toMatchObject({ grams: 255, name: "Greek Yogurt (chobani) · 1.5 × 170 g" });
    expect(NM.portion(yogurt, "250", "g")).toMatchObject({ grams: 250, name: "Greek Yogurt (chobani) · 250 g" });
    expect(NM.portion(juice, "330", "g")).toMatchObject({ nutrition: { kcal: 149 }, name: "Orange juice · 330 ml" });
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

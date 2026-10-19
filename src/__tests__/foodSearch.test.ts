import { SqliteStore } from "../shared/store";
import { type Fetcher, FoodInputError, FoodSourceError, forgetSearches, lookupBarcode, searchFoods, toFood } from "../shared/foodSearch";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
  forgetSearches();
});
afterEach(() => store.close());

const YOGURT = {
  code: "0894700010137",
  product_name: "Greek Yogurt Nonfat Plain",
  brands: "chobani, Other",
  serving_size: "1 serving (170 g)",
  serving_quantity: 170,
  quantity: "32 OZ",
  nutriments: { "energy-kcal_100g": 52.9411764705882, "energy-kj_100g": 229.5, "proteins_100g": 9.5, carbohydrates_100g: 4, fat_100g: 0 },
};

/** A fetcher that answers with `body` (or the given status) and remembers what it was asked. */
function fake(answer: (url: string) => { status?: number; body?: unknown; json?: () => Promise<unknown> } | Error) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const a = answer(url);
    if (a instanceof Error) throw a;
    const status = a.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: a.json ?? (async () => a.body) };
  };
  return { fetcher, calls };
}

describe("a food from an Open Food Facts product", () => {
  it("keeps the nutrition per 100 g, the portion and the first brand", () => {
    expect(toFood(YOGURT)).toEqual({
      code: "0894700010137",
      name: "Greek Yogurt Nonfat Plain",
      brand: "chobani",
      per100: { kcal: 52.9, proteinG: 9.5, carbsG: 4, fatG: 0 },
      nutrients: {},
      complete: true,
      unit: "g",
      servingG: 170,
      servingText: "1 serving (170 g)",
    });
  });

  it("takes the brand from a list, as the search gives it", () => {
    expect(toFood({ ...YOGURT, brands: ["Oikos", "Danone"] })!.brand).toBe("Oikos");
    expect(toFood({ ...YOGURT, brands: [] })!.brand).toBeNull();
    expect(toFood({ ...YOGURT, brands: undefined })!.brand).toBeNull();
  });

  it("reads calories from kilojoules only when the kilocalories are missing", () => {
    const kjOnly = { ...YOGURT, nutriments: { "energy-kj_100g": 418.4, proteins_100g: 1 } };
    expect(toFood(kjOnly)!.per100).toEqual({ kcal: 100, proteinG: 1, carbsG: 0, fatG: 0 });
    expect(toFood({ ...YOGURT, nutriments: { energy_100g: 418.4, proteins_100g: 1 } })!.per100.kcal).toBe(100);
    expect(toFood({ ...YOGURT, nutriments: { "energy-kcal_100g": 55, "energy-kj_100g": 99999, proteins_100g: 1 } })!.per100.kcal).toBe(55);
  });

  it("falls back to another name when the product has none in the usual field", () => {
    expect(toFood({ ...YOGURT, product_name: "", product_name_en: "", product_name_fr: "Yogourt grec" })!.name).toBe("Yogourt grec");
    expect(toFood({ ...YOGURT, product_name: undefined, generic_name: "Yogurt" })!.name).toBe("Yogurt");
  });

  it("knows a liquid by its quantity or portion", () => {
    expect(toFood({ ...YOGURT, serving_size: "250 ml", serving_quantity: "250", quantity: undefined })).toMatchObject({ unit: "ml", servingG: 250 });
    expect(toFood({ ...YOGURT, serving_size: undefined, serving_quantity: undefined, quantity: "1 l" })).toMatchObject({ unit: "ml", servingG: null, servingText: null });
  });

  it("has no portion when the product states none or an absurd one", () => {
    expect(toFood({ ...YOGURT, serving_quantity: undefined })!.servingG).toBeNull();
    expect(toFood({ ...YOGURT, serving_quantity: 0 })!.servingG).toBeNull();
    expect(toFood({ ...YOGURT, serving_quantity: 99999 })!.servingG).toBeNull();
  });

  it.each([
    ["no numbers", { product_name: "Mystery", code: "0000000000017" }],
    ["no calories", { ...YOGURT, nutriments: { proteins_100g: 3 } }],
    ["calories without any macro", { ...YOGURT, nutriments: { "energy-kcal_100g": 50 } }],
    ["no name", { ...YOGURT, product_name: " ", generic_name: "" }],
    ["more than 9 kcal a gram", { ...YOGURT, nutriments: { "energy-kcal_100g": 1200, proteins_100g: 3 } }],
    ["a macro over 100 g", { ...YOGURT, nutriments: { "energy-kcal_100g": 50, proteins_100g: 130 } }],
    ["macros heavier than the food", { ...YOGURT, nutriments: { "energy-kcal_100g": 500, proteins_100g: 60, carbohydrates_100g: 60 } }],
    ["a negative number", { ...YOGURT, nutriments: { "energy-kcal_100g": -5, proteins_100g: 3 } }],
  ])("drops a product with %s", (_, raw) => {
    expect(toFood(raw)).toBeNull();
  });

  it("copes with what is not a product", () => {
    expect(toFood(null)).toBeNull();
    expect(toFood("food")).toBeNull();
    expect(toFood({ ...YOGURT, nutriments: "none" })).toBeNull();
    expect(toFood({ ...YOGURT, code: 42 })!.code).toBeNull();
  });
});

// a Canadian product as Open Food Facts gives it from the product call: every `_100g` value in grams
const KD = {
  code: "0068100904901",
  product_name: "Kraft Dinner",
  nutriments: {
    "energy-kcal_100g": 360, proteins_100g: 13, carbohydrates_100g: 72, fat_100g: 2.5,
    fiber_100g: 2.35, sugars_100g: 12.9, "saturated-fat_100g": 1.76, "trans-fat_100g": 0.1, cholesterol_100g: 0.01,
    sodium_100g: 0.66, salt_100g: 1.65, potassium_100g: 0.4, calcium_100g: 0.125, iron_100g: 0.003,
  },
};

describe("the nutrients of a product", () => {
  it("are read in the unit of the list: grams for fiber and fats, milligrams for the minerals", () => {
    expect(toFood(KD)?.nutrients).toEqual({ fiberG: 2.35, sugarsG: 12.9, satFatG: 1.76, transFatG: 0.1, cholesterolMg: 10, sodiumMg: 660, potassiumMg: 400, calciumMg: 125, ironMg: 3 });
  });

  it("leave out what the product does not state, rather than turning it into zero", () => {
    expect(toFood(YOGURT)?.nutrients).toEqual({});
    const blank = toFood({ ...KD, nutriments: { ...KD.nutriments, "trans-fat_100g": undefined, potassium_100g: null, calcium_100g: "", iron_100g: " " } })?.nutrients;
    for (const key of ["transFatG", "potassiumMg", "calciumMg", "ironMg"]) expect(blank).not.toHaveProperty(key);
    expect(toFood({ ...KD, nutriments: { ...KD.nutriments, calcium_100g: 0 } })?.nutrients?.calciumMg).toBe(0); // a stated zero is a value
  });

  it("take the sodium from the salt when a label states the salt only (a gram of salt holds 0.4 g of sodium)", () => {
    const { sodium_100g, ...saltOnly } = KD.nutriments;
    expect(sodium_100g).toBe(0.66);
    expect(toFood({ ...KD, nutriments: saltOnly })?.nutrients?.sodiumMg).toBe(660);
  });

  it("drop a nutrient that cannot be right, not the whole food", () => {
    const food = toFood({ ...KD, nutriments: { ...KD.nutriments, fiber_100g: 450, sodium_100g: -1, salt_100g: undefined, iron_100g: 70 } });
    expect(food?.per100.kcal).toBe(360);
    expect(food?.nutrients).toMatchObject({ sugarsG: 12.9, calciumMg: 125 });
    expect(food?.nutrients).not.toHaveProperty("fiberG");
    expect(food?.nutrients).not.toHaveProperty("sodiumMg");
    expect(food?.nutrients).not.toHaveProperty("ironMg"); // 70 g of iron in 100 g
  });

  it("do not have to fit inside the carbohydrate: some labels count the fiber apart from it", () => {
    expect(toFood({ ...KD, nutriments: { ...KD.nutriments, carbohydrates_100g: 20, fiber_100g: 30 } })?.nutrients?.fiberG).toBe(30);
  });

  it("make a barcode lookup complete and a search result not, the search index holding only some nutrients", async () => {
    expect(await lookupBarcode(store, "0068100904901", fake(() => ({ body: { status: 1, product: KD } })).fetcher)).toMatchObject({ complete: true, nutrients: { fiberG: 2.35, ironMg: 3 } });
    const found = await searchFoods("kraft dinner", fake(() => ({ body: { hits: [KD] } })).fetcher);
    expect(found[0]).toMatchObject({ complete: false, nutrients: { fiberG: 2.35 } });
  });
});

describe("a product kept before the nutrients were read", () => {
  const old = { code: "0894700010137", name: "Greek Yogurt Nonfat Plain", brand: "chobani", per100: { kcal: 52.9, proteinG: 9.5, carbsG: 4, fatG: 0 }, unit: "g", servingG: 170, servingText: "1 serving (170 g)" };
  const t0 = Date.parse("2026-10-18T12:00:00Z");

  it("is asked for again and kept in its new shape", async () => {
    store.foods.put("0894700010137", old, t0);
    const up = fake(() => ({ body: { status: 1, product: { ...YOGURT, nutriments: { ...YOGURT.nutriments, fiber_100g: 0, sodium_100g: 0.04 } } } }));
    expect(await lookupBarcode(store, "0894700010137", up.fetcher, t0 + 1000)).toMatchObject({ complete: true, nutrients: { fiberG: 0, sodiumMg: 40 } });
    expect(await lookupBarcode(store, "0894700010137", up.fetcher, t0 + 2000)).toMatchObject({ nutrients: { sodiumMg: 40 } });
    expect(up.calls).toHaveLength(1); // the second answer is the kept one
  });

  it("is still the answer, with no nutrients, when the service cannot be asked", async () => {
    store.foods.put("0894700010137", old, t0);
    const down = fake(() => ({ status: 503 }));
    expect(await lookupBarcode(store, "0894700010137", down.fetcher, t0 + 1000)).toEqual({ ...old, nutrients: {}, complete: true });
    expect(down.calls).toHaveLength(1);
    const gone = fake(() => ({ status: 404 }));
    expect(await lookupBarcode(store, "0894700010137", gone.fetcher, t0 + 1000)).toMatchObject({ name: "Greek Yogurt Nonfat Plain", nutrients: {} });
  });
});

describe("looking up a barcode", () => {
  it("asks Open Food Facts for the product, naming the application, and keeps what it found", async () => {
    const { fetcher, calls } = fake(() => ({ body: { status: 1, product: YOGURT } }));
    const food = await lookupBarcode(store, "894700010137", fetcher);
    expect(food).toMatchObject({ name: "Greek Yogurt Nonfat Plain", per100: { kcal: 52.9 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/894700010137\.json\?fields=code,product_name,product_name_en,product_name_fr,generic_name/);
    expect(calls[0].headers["User-Agent"]).toMatch(/^garmin-workout-editor\//);
    expect(calls[0].headers["User-Agent"]).not.toMatch(/@/); // no address of the person
  });

  it("answers a barcode scanned before from the database, until the month is over", async () => {
    const { fetcher, calls } = fake(() => ({ body: { status: 1, product: YOGURT } }));
    const t0 = Date.parse("2026-10-18T12:00:00Z");
    await lookupBarcode(store, "894700010137", fetcher, t0);
    expect(await lookupBarcode(store, "894700010137", fetcher, t0 + 29 * 86_400_000)).toMatchObject({ name: "Greek Yogurt Nonfat Plain" });
    expect(calls).toHaveLength(1);
    await lookupBarcode(store, "894700010137", fetcher, t0 + 31 * 86_400_000);
    expect(calls).toHaveLength(2);
  });

  it("still has a scanned product when the service is down", async () => {
    const up = fake(() => ({ body: { status: 1, product: YOGURT } }));
    await lookupBarcode(store, "894700010137", up.fetcher);
    const down = fake(() => ({ status: 503 }));
    expect(await lookupBarcode(store, "894700010137", down.fetcher)).toMatchObject({ name: "Greek Yogurt Nonfat Plain" });
    expect(down.calls).toHaveLength(0);
  });

  it("finds nothing for an unknown barcode, and does not keep the miss", async () => {
    const miss = fake(() => ({ body: { code: "00000017", status: 0, status_verbose: "no code or invalid code" } }));
    expect(await lookupBarcode(store, "00000017", miss.fetcher)).toBeNull();
    expect(await lookupBarcode(store, "00000017", fake(() => ({ status: 404 })).fetcher)).toBeNull();
    const stub = fake(() => ({ body: { status: 1, product: { code: "9780000000002" } } })); // a product with no data at all
    expect(await lookupBarcode(store, "9780000000002", stub.fetcher)).toBeNull();
    const later = fake(() => ({ body: { status: 1, product: YOGURT } }));
    expect(await lookupBarcode(store, "00000017", later.fetcher)).not.toBeNull(); // it was asked again: the miss was not kept
    expect(later.calls).toHaveLength(1);
  });

  it.each(["", "abc", "1234567", "123456789012345", "30176 20422003", undefined, 3017620422003])("refuses %p as a barcode", async (code) => {
    const { fetcher, calls } = fake(() => ({ body: {} }));
    await expect(lookupBarcode(store, code, fetcher)).rejects.toThrow(FoodInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("searching by name", () => {
  const hit = (code: string, name: string, kcal = 100) => ({ code, product_name: name, brands: ["Brand"], nutriments: { "energy-kcal_100g": kcal, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 2 } });

  it("returns the usable foods in order, without the same product twice", async () => {
    const { fetcher, calls } = fake(() => ({ body: { hits: [hit("3017620422003", "Greek yogurt"), { code: "4006381333931", product_name: "No numbers" }, hit("3017620422003", "Greek yogurt again"), hit("5000112637922", "Skyr", 63)] } }));
    const foods = await searchFoods("  greek   yogurt ", fetcher);
    expect(foods.map((f) => [f.code, f.name])).toEqual([["3017620422003", "Greek yogurt"], ["5000112637922", "Skyr"]]);
    expect(calls[0].url).toMatch(/^https:\/\/search\.openfoodfacts\.org\/search\?q=greek%20yogurt&page_size=30&fields=/);
  });

  it("returns at most 20", async () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit(String(100 + i), `Food ${i}`));
    expect(await searchFoods("food", fake(() => ({ body: { hits } })).fetcher)).toHaveLength(20);
  });

  it("answers the same words again from memory for ten minutes", async () => {
    const { fetcher, calls } = fake(() => ({ body: { hits: [hit("3017620422003", "Rice")] } }));
    const t0 = Date.now();
    await searchFoods("Rice", fetcher, t0);
    await searchFoods("rice ", fetcher, t0 + 9 * 60_000);
    expect(calls).toHaveLength(1);
    await searchFoods("rice", fetcher, t0 + 11 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it("finds nothing without failing", async () => {
    expect(await searchFoods("zzzzqq", fake(() => ({ body: { hits: [] } })).fetcher)).toEqual([]);
    expect(await searchFoods("zzzzqq2", fake(() => ({ body: {} })).fetcher)).toEqual([]);
  });

  it.each(["", " ", "a", "x".repeat(81), undefined, 5])("refuses the search %p", async (q) => {
    const { fetcher, calls } = fake(() => ({ body: { hits: [] } }));
    await expect(searchFoods(q, fetcher)).rejects.toThrow(FoodInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("when Open Food Facts cannot answer", () => {
  it.each([
    ["a busy service", () => ({ status: 503 }), /unavailable right now \(503\)/],
    ["a rate limit", () => ({ status: 429 }), /slow down/],
    ["a page that is not JSON", () => ({ json: async () => { throw new SyntaxError("Unexpected token <"); } }), /unavailable right now\./],
    ["no network", () => new TypeError("fetch failed"), /could not be reached/],
  ])("says so for %s, in words for the person", async (_, answer, message) => {
    await expect(searchFoods("rice", fake(answer as any).fetcher)).rejects.toThrow(FoodSourceError);
    await expect(searchFoods("rice2", fake(answer as any).fetcher)).rejects.toThrow(message);
    await expect(lookupBarcode(store, "3017620422003", fake(answer as any).fetcher)).rejects.toThrow(message);
  });

  it("gives up after a few seconds", async () => {
    jest.useFakeTimers();
    try {
      const hang: Fetcher = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const pending = expect(searchFoods("slow", hang)).rejects.toThrow(/did not answer in time/);
      await jest.advanceTimersByTimeAsync(8100);
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not keep a failed search", async () => {
    await expect(searchFoods("flaky", fake(() => ({ status: 503 })).fetcher)).rejects.toThrow();
    expect(await searchFoods("flaky", fake(() => ({ body: { hits: [{ code: "1", product_name: "Ok", nutriments: { "energy-kcal_100g": 10, proteins_100g: 1 } }] } })).fetcher)).toHaveLength(1);
  });
});

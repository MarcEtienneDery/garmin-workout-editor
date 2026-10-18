import { Decoder, Stream } from "@garmin/fitsdk";
import { toWeighIn, weighInsToFit } from "../shared/renphoFit";

const decode = (bytes: Uint8Array) => {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  expect(decoder.isFIT()).toBe(true);
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return messages as any;
};
const row = (over: Record<string, unknown> = {}) => ({ id: "1", timeStamp: 1_760_000_000, weight: 81.7, bodyfat: 17.84, water: 56.12, muscle: 44.5, bone: 3.84, bmi: 24.93, visfat: 7, bodyage: 34, bmr: 1850.4, ...over });

describe("a Renpho weigh-in as a FIT weigh-in", () => {
  it("maps the numbers to the units of a FIT weight_scale message, muscle from a percentage of the weight to kilograms", () => {
    expect(toWeighIn(row())).toEqual({
      at: new Date(1_760_000_000_000), weight: 81.7, percentFat: 17.8, percentHydration: 56.1, boneMass: 3.84, muscleMass: 36.36, basalMet: 1850, metabolicAge: 34, visceralFatRating: 7, bmi: 24.9,
    });
  });

  it("reads numbers sent as text, leaves out what is missing or not positive, and has none without a weight or a time", () => {
    const w = toWeighIn(row({ weight: "80.5", bodyfat: "", water: 0, muscle: null, bone: undefined, bmr: "n/a" }))!;
    expect(w.weight).toBe(80.5);
    expect(w).toEqual(expect.objectContaining({ percentFat: undefined, percentHydration: undefined, muscleMass: undefined, boneMass: undefined, basalMet: undefined }));
    expect(toWeighIn(row({ weight: null }))).toBeNull();
    expect(toWeighIn(row({ timeStamp: undefined }))).toBeNull();
  });
});

describe("the FIT file", () => {
  it("is a weight file that the FIT SDK reads back, oldest weigh-in first", () => {
    const a = toWeighIn(row({ timeStamp: 1_760_000_000, weight: 82.1 }))!, b = toWeighIn(row({ timeStamp: 1_760_100_000, weight: 81.4, bodyfat: undefined }))!;
    const messages = decode(weighInsToFit([b, a]));
    expect(messages.fileIdMesgs[0]).toEqual(expect.objectContaining({ type: "weight", manufacturer: "development" }));
    expect(messages.weightScaleMesgs).toHaveLength(2);
    expect(messages.weightScaleMesgs[0]).toEqual(expect.objectContaining({ timestamp: a.at, weight: 82.1, percentFat: 17.8, percentHydration: 56.1, boneMass: 3.84, muscleMass: 36.53, basalMet: 1850, metabolicAge: 34, visceralFatRating: 7, bmi: 24.9 }));
    expect(messages.weightScaleMesgs[1]).toEqual(expect.objectContaining({ timestamp: b.at, weight: 81.4 }));
    expect(messages.weightScaleMesgs[1].percentFat).toBeUndefined();
  });

  it("refuses to make a file of nothing", () => {
    expect(() => weighInsToFit([])).toThrow(/no weigh-in/);
  });
});

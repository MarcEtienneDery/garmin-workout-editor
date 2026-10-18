/**
 * renphoFit.ts — Renpho weigh-ins as a FIT file of the kind a Garmin scale writes (a "weight" file of weight_scale
 * messages), which Garmin Connect takes in as weigh-ins with their body composition. Built with Garmin's own FIT SDK.
 *
 * What Renpho calls each number is read from sources that are not Renpho's and disagree in places (which of `muscle` and
 * `bone` is a mass, which a percentage), so the mapping is the few lines in `toWeighIn`, kept in one place and checked
 * against the app on the first file that is imported.
 */
import { Encoder, Profile } from "@garmin/fitsdk";

/** One weigh-in, in the units a FIT weight_scale message has (kg, %, kcal a day). */
export interface WeighIn {
  at: Date;
  weight: number;
  percentFat?: number;
  percentHydration?: number;
  boneMass?: number;
  muscleMass?: number;
  basalMet?: number;
  metabolicAge?: number;
  visceralFatRating?: number;
  bmi?: number;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};
const round = (v: number | undefined, digits = 1): number | undefined => (v === undefined ? undefined : Math.round(v * 10 ** digits) / 10 ** digits);

/** What Renpho's `timeStamp` (seconds since the epoch) and its numbers say, in the units of a FIT weigh-in; null when there is no weight. */
export function toWeighIn(data: Record<string, unknown>): WeighIn | null {
  const weight = num(data.weight), seconds = num(data.timeStamp);
  if (weight === undefined || seconds === undefined) return null;
  const muscle = num(data.muscle);
  return {
    at: new Date(seconds * 1000),
    weight: round(weight, 2) as number,
    percentFat: round(num(data.bodyfat)),
    percentHydration: round(num(data.water)),
    boneMass: round(num(data.bone), 2),
    // `muscle` is skeletal muscle as a percentage of the body weight in the sources read: Garmin wants kilograms
    muscleMass: muscle === undefined ? undefined : round((weight * muscle) / 100, 2),
    basalMet: round(num(data.bmr), 0),
    metabolicAge: round(num(data.bodyage), 0),
    visceralFatRating: round(num(data.visfat), 0),
    bmi: round(num(data.bmi)),
  };
}

/** The FIT file of the weigh-ins, oldest first. */
export function weighInsToFit(weighIns: WeighIn[]): Uint8Array {
  const sorted = [...weighIns].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!sorted.length) throw new Error("There is no weigh-in to put in a FIT file.");
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: "weight", manufacturer: "development", product: 0, serialNumber: 1, timeCreated: sorted[0].at } as any);
  for (const w of sorted) {
    const message: Record<string, unknown> = { timestamp: w.at };
    for (const [key, value] of Object.entries(w)) if (key !== "at" && value !== undefined) message[key] = value;
    encoder.onMesg(Profile.MesgNum.WEIGHT_SCALE, message as any);
  }
  return encoder.close();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NM = require("../web/public/navModel.js");

const info = (over: any = {}) => ({ garmin: false, renpho: false, hasActivities: false, hasWellness: false, hasWeight: false, ...over });

describe("the views a profile can use", () => {
  it("offers Today, Plans, Calendar and Food to a profile with nothing connected", () => {
    expect(NM.viewsFor(info())).toEqual({ today: true, plans: true, calendar: true, food: true, workouts: false, activities: false, recovery: false, weight: false });
    expect(NM.viewsFor(null)).toEqual(NM.viewsFor(info()));
  });

  it("offers everything that needs Garmin to a profile that has a Garmin login", () => {
    expect(NM.viewsFor(info({ garmin: true }))).toEqual({ today: true, plans: true, calendar: true, food: true, workouts: true, activities: true, recovery: true, weight: true });
  });

  it("offers Weight to a profile with a Renpho scale alone, and nothing else beyond the always-on views", () => {
    expect(NM.viewsFor(info({ renpho: true }))).toEqual(expect.objectContaining({ weight: true, workouts: false, activities: false, recovery: false }));
  });

  it("keeps a view that has data stored, after Garmin or the scale was disconnected, but not the Workouts view, which is Garmin's library", () => {
    const v = NM.viewsFor(info({ hasActivities: true, hasWellness: true, hasWeight: true }));
    expect(v).toEqual(expect.objectContaining({ activities: true, recovery: true, weight: true, workouts: false }));
  });
});

describe("the views of all the profiles", () => {
  it("shows a view when any profile can use it", () => {
    const shown = NM.visibleViews({ SAM: info(), MED: info({ garmin: true }) });
    expect(shown).toEqual(expect.objectContaining({ workouts: true, activities: true, weight: true }));
    expect(NM.visibleViews({ SAM: info(), JO: info({ renpho: true }) })).toEqual(expect.objectContaining({ weight: true, workouts: false }));
  });

  it("offers the always-on views when there is no profile yet", () => {
    expect(NM.visibleViews({})).toEqual(NM.viewsFor(null));
    expect(NM.visibleViews(undefined)).toEqual(NM.viewsFor(null));
  });
});

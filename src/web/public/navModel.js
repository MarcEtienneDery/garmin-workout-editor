(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NavModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function viewsFor(info) {
    const has = info || {};
    return {
      today: true,
      plans: true,
      calendar: true,
      food: true,
      workouts: !!has.garmin,
      activities: !!has.garmin || !!has.hasActivities,
      recovery: !!has.garmin || !!has.hasWellness,
      weight: !!has.garmin || !!has.renpho || !!has.hasWeight,
    };
  }

  function visibleViews(profileInfo) {
    const out = viewsFor(null);
    for (const info of Object.values(profileInfo || {})) {
      const v = viewsFor(info);
      for (const k of Object.keys(out)) out[k] = out[k] || v[k];
    }
    return out;
  }

  return { viewsFor, visibleViews };
});

/*
 * navModel.js — which views the page offers, from what each profile has connected or stored (pure).
 *
 * Garmin and the Renpho scale are optional. A view that only means something with one of them shows when a profile has it, or
 * has something stored from it (a Garmin login that was removed leaves its activities behind). Today, Plans, Calendar and Food
 * are always there. The page passes GET /api/garmin's profileInfo ({ [profile]: { garmin, renpho, hasActivities, hasWellness,
 * hasWeight } }); the tests require() this file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NavModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** The views one profile can use. */
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

  /** The views any of the profiles can use: a profile login sees one profile, the admin sees them all. */
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

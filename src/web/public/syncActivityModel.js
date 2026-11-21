(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncActivityModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WORDS = { activities: "activities", wellness: "health data", renpho: "weight" };

  function clock(ms, now) {
    const d = new Date(ms), n = new Date(now);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === n.toDateString() ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time;
  }

  function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }

  const list = (items) => (items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]);

  function summary(activity) {
    if (!activity || !activity.profiles) return null;
    const now = activity.now || Date.now();
    const entries = Object.entries(activity.profiles);
    const several = entries.length > 1;

    const limited = entries.filter(([, p]) => p && p.limit).sort((a, b) => b[1].limit.lastAt - a[1].limit.lastAt);
    if (limited.length) {
      const [, first] = limited[0];
      const who = several ? " for " + list(limited.map(([name]) => name)) : "";
      const times = first.limit.count > 1 ? first.limit.count + " requests refused since " + clock(first.limit.since, now) : "refused at " + clock(first.limit.lastAt, now);
      return {
        kind: "limit",
        long: "Garmin: 429 · too many requests",
        short: "429",
        title:
          "Garmin is turning requests away with HTTP 429, Too Many Requests" + who + " (last " + ago(first.limit.lastAt, now) + ", " + times + "). " +
          "Syncing, uploads and sign-in from here fail until it lifts, and trying again can make it last longer: leave it alone for a while.",
      };
    }

    const running = [];
    const kinds = new Set();
    for (const [name, p] of entries) {
      if (!p || !p.syncing || !p.syncing.length) continue;
      running.push(name);
      for (const k of p.syncing) kinds.add(k);
    }
    if (!running.length) return null;
    const what = list(Object.keys(WORDS).filter((k) => kinds.has(k)).map((k) => WORDS[k]));
    return {
      kind: "syncing",
      long: "Syncing " + what + "…",
      short: "Syncing",
      title: "Syncing " + what + (several ? " for " + list(running) : "") + ". It runs in the background; the views fill in as it goes.",
    };
  }

  function busy(activity) {
    return !!activity && Object.values(activity.profiles || {}).some((p) => p && p.syncing && p.syncing.length);
  }

  return { summary, busy, clock, ago };
});

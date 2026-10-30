/** Dates relative to the day the suite runs, so seeded data is always "recent" whatever the calendar says. The server and the browsers run in UTC. */
const DAY = 86_400_000;

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => iso(new Date());
export const daysAgo = (n: number) => iso(new Date(Date.now() - n * DAY));
export const daysAhead = (n: number) => iso(new Date(Date.now() + n * DAY));
/** The Monday of the week a day falls in. */
export const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
};

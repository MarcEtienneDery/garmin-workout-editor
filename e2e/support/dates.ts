const DAY = 86_400_000;

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => iso(new Date());
export const daysAgo = (n: number) => iso(new Date(Date.now() - n * DAY));
export const daysAhead = (n: number) => iso(new Date(Date.now() + n * DAY));
export const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
};

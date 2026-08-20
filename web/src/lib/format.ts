const TOKEN_UNITS = [
  { value: 1e12, suffix: "T" },
  { value: 1e9, suffix: "B" },
  { value: 1e6, suffix: "M" },
  { value: 1e3, suffix: "K" },
] as const;

export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const unit = TOKEN_UNITS.find((candidate) => Math.abs(value) >= candidate.value);
  if (!unit) return value.toFixed(2);
  return `${(value / unit.value).toFixed(2)}${unit.suffix}`;
}

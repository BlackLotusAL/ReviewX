/** Presentation only: interpolate the background without changing the stored score. */
export function confidenceDisplay(value: unknown): { label: string; background: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return { label: "未评估", background: "#eef0f2" };
  }
  const red = [255, 228, 230];
  const yellow = [255, 243, 196];
  const green = [220, 252, 231];
  const [from, to, fraction] = value <= 50
    ? [red, yellow, value / 50] as const
    : [yellow, green, (value - 50) / 50] as const;
  const channels = from.map((channel, index) => Math.round(channel + (to[index] - channel) * fraction));
  return { label: `${value}/100`, background: `rgb(${channels.join(", ")})` };
}

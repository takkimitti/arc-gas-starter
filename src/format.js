export function shortenAddress(address) {
  if (typeof address !== "string" || address.length < 12) return address || "—";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
export function formatNativeUsdc(hexBalance, maximumFractionDigits = 6) {
  const value = BigInt(hexBalance);
  const decimals = 18n;
  const base = 10n ** decimals;
  const whole = value / base;
  const fraction = (value % base).toString().padStart(Number(decimals), "0");
  const visible = fraction.slice(0, maximumFractionDigits).replace(/0+$/, "");
  return visible ? `${whole}.${visible}` : whole.toString();
}
export function isPositiveBalance(hexBalance) {
  return BigInt(hexBalance) > 0n;
}

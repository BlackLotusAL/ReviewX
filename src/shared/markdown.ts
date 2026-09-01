function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)?.slice(1).map(Number);
  if (ipv4?.length === 4 && ipv4.every((part) => part >= 0 && part <= 255)) {
    const [first, second] = ipv4;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19));
  }
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/u.test(host) || host.startsWith("ff")) return true;
  const mapped = host.match(/::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/u);
  if (!mapped) return false;
  if (mapped[1]) return privateHost(mapped[1]);
  const high = Number.parseInt(mapped[2] ?? "0", 16);
  const low = Number.parseInt(mapped[3] ?? "0", 16);
  return privateHost(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
}

export function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || privateHost(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

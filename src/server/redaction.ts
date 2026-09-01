const SECRET_KEY_PATTERN = /(authorization|password|passwd|private[-_]?token|x-auth-token|api[-_]?key|secret|credential|token)/iu;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/giu;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -\/]*[@-~]/gu;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/u;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/gu;
const WELL_KNOWN_TOKEN_PATTERN = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})\b/u;

export class Redactor {
  readonly #secretValues: readonly string[];

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.#secretValues = Object.entries(environment)
      .filter(([key, value]) => value && value.length >= 8 && SECRET_KEY_PATTERN.test(key))
      .map(([, value]) => value as string)
      .sort((left, right) => right.length - left.length);
  }

  containsCredential(value: string): boolean {
    if (URL_USERINFO_PATTERN.test(value) || PRIVATE_KEY_PATTERN.test(value) || WELL_KNOWN_TOKEN_PATTERN.test(value)) {
      URL_USERINFO_PATTERN.lastIndex = 0;
      return true;
    }
    URL_USERINFO_PATTERN.lastIndex = 0;
    return this.#secretValues.some((secret) => value.includes(secret));
  }

  redact(value: string): string {
    URL_USERINFO_PATTERN.lastIndex = 0;
    let result = value
      .replace(ANSI_PATTERN, "")
      .replace(URL_USERINFO_PATTERN, "$1[REDACTED]@")
      .replace(PRIVATE_KEY_BLOCK_PATTERN, "[REDACTED PRIVATE KEY]")
      .replace(PRIVATE_KEY_PATTERN, "-----BEGIN [REDACTED] PRIVATE KEY-----")
      .replace(WELL_KNOWN_TOKEN_PATTERN, "[REDACTED]");
    result = result.replace(
      /(["']?(?:authorization|password|passwd|private[-_]?token|x-auth-token|api[-_]?key|secret|credential|token)["']?\s*[:=]\s*)(["']?)([^\s,"'}&]+)(\2)/giu,
      "$1$2[REDACTED]$4",
    );
    for (const secret of this.#secretValues) result = result.split(secret).join("[REDACTED]");
    return result;
  }
}

export function escapeSingleLine(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (code < 0x20 || code === 0x7f) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return result;
}

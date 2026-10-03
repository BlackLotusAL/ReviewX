import { z } from "zod";

export const positiveIdSchema = z.string().regex(/^[1-9]\d*$/u);

export function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const credentialFreeHttpsUrlSchema = z.string().url().refine(isCredentialFreeHttpsUrl, "URL must be credential-free HTTPS");

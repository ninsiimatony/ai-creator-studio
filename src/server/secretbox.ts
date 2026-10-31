// AES-256-GCM encryption for secrets stored in D1 (Google refresh tokens).
// Format: v1.<iv>.<ciphertext>, base64url. The key comes from the TOKEN_ENC_KEY secret.
import { AppError } from "./errors";

const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const t = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
};

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  if (!keyB64) throw new AppError("TOKEN_ENC_KEY is not configured.");
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keyB64.trim()), (c) => c.charCodeAt(0));
  } catch {
    throw new AppError("TOKEN_ENC_KEY must be base64 of 32 random bytes.");
  }
  if (raw.length !== 32) throw new AppError("TOKEN_ENC_KEY must be base64 of 32 random bytes.");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plain: string, keyB64: string | undefined): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plain),
  );
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

export async function decryptSecret(token: string, keyB64: string | undefined): Promise<string> {
  const [v, iv, ct] = token.split(".");
  if (v !== "v1" || !iv || !ct)
    throw new AppError("Stored credential is corrupted. Reconnect YouTube.");
  const key = await importKey(keyB64);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64u(iv) as BufferSource },
      key,
      unb64u(ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new AppError("Could not decrypt the stored credential (wrong key?). Reconnect YouTube.");
  }
}

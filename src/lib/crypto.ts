import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/** AES-256-GCM for secrets at rest (Google refresh tokens). Output: base64(iv | tag | ciphertext). */

function key(): Buffer {
  const k = Buffer.from(env().SEOPEN_SECRET_KEY, "base64");
  if (k.length !== 32) throw new Error("SEOPEN_SECRET_KEY must decode to 32 bytes");
  return k;
}

const IV = 12;
/** Pinned, so a cut-short payload can't pass a shorter tag: Node otherwise accepts tags down to 4 bytes. */
const TAG = 16;

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key(), iv, { authTagLength: TAG });
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV + TAG) throw new Error("Encrypted value is too short");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, IV), { authTagLength: TAG });
  decipher.setAuthTag(buf.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(buf.subarray(IV + TAG)), decipher.final()]).toString("utf8");
}

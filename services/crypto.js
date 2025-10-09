import crypto from "crypto";

const ENC_KEY = process.env.ENC_KEY || ""; // 32 bytes (hex/base64) recomendado
if (!ENC_KEY) {
  console.warn("[crypto] ENC_KEY ausente. credentials_encrypted ficarão null.");
}

function getKey() {
  if (!ENC_KEY) return null;
  // aceita base64 (32 bytes) ou hex
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(ENC_KEY)) {
      const buf = Buffer.from(ENC_KEY, "base64");
      if (buf.length === 16 || buf.length === 24 || buf.length === 32) return buf; // 128/192/256
    }
    const hex = Buffer.from(ENC_KEY, "hex");
    if (hex.length === 16 || hex.length === 24 || hex.length === 32) return hex;
  } catch {}
  // fallback: corta/expande
  const b = Buffer.alloc(32);
  Buffer.from(ENC_KEY).copy(b);
  return b;
}

export function encryptToBytea(plain) {
  if (!plain || !ENC_KEY) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: iv(12) | tag(16) | data
  return Buffer.concat([iv, tag, enc]);
}

export function decryptFromBytea(buf) {
  if (!buf || !ENC_KEY) return null;
  const key = getKey();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

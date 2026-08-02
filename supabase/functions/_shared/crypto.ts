import { base64ToBytes, bytesToBase64 } from "./webhook.ts";

export interface EncryptedSecret {
  ciphertextBase64: string;
  ivBase64: string;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64Key);
  if (bytes.byteLength !== 32) {
    throw new Error("Token encryption key must contain exactly 32 bytes");
  }

  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(value: string, base64Key: string): Promise<EncryptedSecret> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  ));

  return {
    ciphertextBase64: bytesToBase64(ciphertext),
    ivBase64: bytesToBase64(iv),
  };
}

export async function decryptSecret(
  ciphertextBase64: string,
  ivBase64: string,
  base64Key: string,
): Promise<string> {
  const key = await importAesKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(base64ToBytes(ivBase64)) },
    key,
    Uint8Array.from(base64ToBytes(ciphertextBase64)),
  );
  return new TextDecoder().decode(plaintext);
}

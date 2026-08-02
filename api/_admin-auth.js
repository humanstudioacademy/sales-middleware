import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "__Host-humanos_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function safeEqual(left, right) {
  const a = createHmac("sha256", "humanos-admin-compare").update(String(left)).digest();
  const b = createHmac("sha256", "humanos-admin-compare").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function signature(expiresAt, secret) {
  return createHmac("sha256", secret).update(String(expiresAt)).digest("base64url");
}

export function adminEnvironment() {
  const password = process.env.ADMIN_PASSWORD;
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  if (!password || !sessionSecret || sessionSecret.length < 32) throw new Error("Admin authentication is not configured");
  return { password, sessionSecret };
}

export function validAdminPassword(candidate, password) {
  return typeof candidate === "string" && candidate.length <= 256 && safeEqual(candidate, password);
}

export function createAdminSession(sessionSecret, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${signature(expiresAt, sessionSecret)}`;
}

export function adminSessionCookie(value) {
  return `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function hasValidAdminSession(cookieHeader, sessionSecret, now = Date.now()) {
  const cookies = Object.fromEntries(String(cookieHeader ?? "").split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part.trim(), ""] : [part.slice(0, separator).trim(), part.slice(separator + 1)];
  }));
  const token = cookies[ADMIN_COOKIE];
  if (!token) return false;
  const [rawExpiry, providedSignature, ...extra] = token.split(".");
  const expiresAt = Number(rawExpiry);
  if (extra.length || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  return safeEqual(providedSignature, signature(expiresAt, sessionSecret));
}

export function secureHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_COOKIE, createAdminSession, hasValidAdminSession, validAdminPassword } from "../api/_admin-auth.js";

test("admin password comparison and signed session reject invalid credentials", () => {
  const secret = "s".repeat(48);
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const token = createAdminSession(secret, now);
  assert.equal(validAdminPassword("correct", "correct"), true);
  assert.equal(validAdminPassword("wrong", "correct"), false);
  assert.equal(hasValidAdminSession(`${ADMIN_COOKIE}=${token}`, secret, now), true);
  assert.equal(hasValidAdminSession(`${ADMIN_COOKIE}=${token}x`, secret, now), false);
  assert.equal(hasValidAdminSession(`${ADMIN_COOKIE}=${token}`, secret, now + 9 * 60 * 60 * 1000), false);
});

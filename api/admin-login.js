import { adminEnvironment, adminSessionCookie, createAdminSession, secureHeaders, validAdminPassword } from "./_admin-auth.js";

export default async function handler(request, response) {
  Object.entries(secureHeaders()).forEach(([name, value]) => response.setHeader(name, value));
  if (request.method !== "POST") return response.status(405).json({ error: "method_not_allowed" });
  try {
    const { password, sessionSecret } = adminEnvironment();
    const input = typeof request.body === "object" && request.body !== null ? request.body : JSON.parse(String(request.body ?? "{}"));
    if (!validAdminPassword(input.password, password)) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return response.status(401).json({ error: "invalid_credentials" });
    }
    response.setHeader("Set-Cookie", adminSessionCookie(createAdminSession(sessionSecret)));
    return response.status(200).json({ ok: true });
  } catch {
    return response.status(503).json({ error: "temporarily_unavailable" });
  }
}

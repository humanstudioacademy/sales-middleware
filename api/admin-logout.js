import { clearAdminSessionCookie, secureHeaders } from "./_admin-auth.js";

export default function handler(request, response) {
  Object.entries(secureHeaders()).forEach(([name, value]) => response.setHeader(name, value));
  if (request.method !== "POST") return response.status(405).json({ error: "method_not_allowed" });
  response.setHeader("Set-Cookie", clearAdminSessionCookie());
  return response.status(200).json({ ok: true });
}

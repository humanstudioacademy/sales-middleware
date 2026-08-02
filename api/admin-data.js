import { adminEnvironment, hasValidAdminSession, secureHeaders } from "./_admin-auth.js";

const QUEUE_STATUS_ENDPOINT = "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/queue-status";

export default async function handler(request, response) {
  Object.entries(secureHeaders()).forEach(([name, value]) => response.setHeader(name, value));
  if (request.method !== "GET") return response.status(405).json({ error: "method_not_allowed" });
  try {
    const { sessionSecret } = adminEnvironment();
    if (!hasValidAdminSession(request.headers.cookie, sessionSecret)) return response.status(401).json({ error: "unauthorized" });
    const upstream = await fetch(`${QUEUE_STATUS_ENDPOINT}?recent_limit=50`, {
      headers: { authorization: `Bearer ${process.env.STATUS_API_SECRET}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!upstream.ok) throw new Error("status_unavailable");
    return response.status(200).json(await upstream.json());
  } catch {
    return response.status(503).json({ error: "temporarily_unavailable" });
  }
}

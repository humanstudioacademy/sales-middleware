const WEBHOOK_ENDPOINT =
  "https://mid.humanacademy.ai/webhook";
const DIRECT_WEBHOOK_ENDPOINT =
  "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/zolt-webhook";
const QUEUE_STATUS_ENDPOINT =
  "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/queue-status";

export default function handler(_request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    service: "sales-middleware",
    status: "operational",
    ingress: {
      method: "POST",
      url: WEBHOOK_ENDPOINT,
      direct_storage_url: DIRECT_WEBHOOK_ENDPOINT,
      authentication: "none at public ingress; secret injected internally",
    },
    queue_status: {
      method: "GET",
      url: QUEUE_STATUS_ENDPOINT,
      authentication: "Authorization: Bearer <STATUS_API_SECRET>",
    },
  });
}

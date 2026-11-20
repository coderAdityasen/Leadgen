/**
 * Cloudflare Pages Function: forwards every /api/* request from the dashboard to the Lead Desk
 * server (Render). The browser only ever talks to the dashboard's own address, so the login
 * cookie stays first-party and no CORS setup is needed.
 *
 * Set in Cloudflare Pages -> Settings -> Variables:
 *   LEAD_DESK_API_ORIGIN = https://your-service.onrender.com   (no trailing slash, no path)
 */
export async function onRequest({ request, env }) {
  const origin = (env.LEAD_DESK_API_ORIGIN || "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(origin)) {
    return Response.json(
      { error: { code: "proxy_not_configured", message: "LEAD_DESK_API_ORIGIN is not set on the dashboard host.", details: {} } },
      { status: 502 }
    );
  }

  const incoming = new URL(request.url);
  const target = origin + incoming.pathname + incoming.search;

  const headers = new Headers(request.headers);
  // The server builds invite links and rate-limits logins from these.
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);
  headers.set("X-Forwarded-Host", incoming.host);
  headers.set("X-Forwarded-Proto", "https");
  headers.delete("Host");

  const method = request.method.toUpperCase();
  const response = await fetch(target, {
    method,
    headers,
    // Buffered: request bodies are small (the server caps them at 256 KB), and Razorpay webhook
    // signatures need the exact bytes.
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });

  // Pass the response through untouched (status, Set-Cookie, body).
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("X-LeadDesk-Client", "web");
  }

  if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 204) {
    return {} as T;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const error = (data as { error?: ApiError })?.error ?? {
      code: `http_${res.status}`,
      message: res.statusText || "Request failed",
    };

    if (
      res.status === 401 &&
      !path.startsWith("/api/v1/session") &&
      !path.startsWith("/api/v1/me/password")
    ) {
      window.location.href = "/login";
    }

    throw error;
  }

  return data as T;
}

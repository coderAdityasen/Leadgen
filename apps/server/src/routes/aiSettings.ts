import type { FastifyPluginAsync } from "fastify";
import { requireOperatorSession } from "../auth.js";
import {
  type AiSettingsRow,
  assertAllowedAiHost,
  encryptApiKey,
  decryptApiKey,
  probeAiConnection,
} from "../ai.js";

// Rate limit: 5 probe calls per hour
const probeTimestamps: number[] = [];

export function resetProbeRateLimitForTesting(): void {
  probeTimestamps.length = 0;
}

function checkProbeRateLimit(now: number): boolean {
  const oneHourAgo = now - 3600_000;
  while (probeTimestamps.length > 0 && probeTimestamps[0]! < oneHourAgo) {
    probeTimestamps.shift();
  }
  if (probeTimestamps.length >= 5) {
    return false;
  }
  probeTimestamps.push(now);
  return true;
}

function formatAiSettingsResponse(row: AiSettingsRow) {
  return {
    mode: row.mode,
    systemInstructions: row.system_instructions,
    providerBaseUrl: row.provider_base_url,
    model: row.model,
    apiKeyLast4: row.api_key_last4,
    apiKeySet: Boolean(row.api_key_ciphertext),
    maxCompletionTokens: row.max_completion_tokens,
  };
}

export const aiSettingsRoutes: FastifyPluginAsync = async (app) => {
  // GET /ai-settings
  app.get("/ai-settings", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;

    const row = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as AiSettingsRow;
    return reply.code(200).send(formatAiSettingsResponse(row));
  });

  // PUT /ai-settings
  app.put("/ai-settings", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const body = (request.body ?? {}) as {
      mode?: string;
      systemInstructions?: string;
      providerBaseUrl?: string;
      model?: string;
      maxCompletionTokens?: number;
      apiKey?: string;
    };

    const currentRow = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as AiSettingsRow;

    // Validation
    if (body.mode !== undefined) {
      if (body.mode !== "off" && body.mode !== "approve" && body.mode !== "auto") {
        return reply.code(400).send({
          error: {
            code: "validation",
            message: "Mode must be 'off', 'approve', or 'auto'.",
            details: {},
          },
        });
      }
    }

    if (body.systemInstructions !== undefined) {
      if (
        typeof body.systemInstructions !== "string" ||
        body.systemInstructions.length < 1 ||
        body.systemInstructions.length > 4000
      ) {
        return reply.code(400).send({
          error: {
            code: "validation",
            message: "systemInstructions must be between 1 and 4,000 characters.",
            details: {},
          },
        });
      }
    }

    if (body.providerBaseUrl !== undefined) {
      try {
        assertAllowedAiHost(body.providerBaseUrl);
      } catch (err: any) {
        return reply.code(400).send({
          error: {
            code: "validation",
            message: err.message || "Invalid provider base URL.",
            details: {},
          },
        });
      }
    }

    if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
      return reply.code(400).send({
        error: { code: "validation", message: "apiKey must be a string.", details: {} },
      });
    }

    // Moving the stored key to a different host would hand the old provider's secret to
    // the new one. Require the key to be re-entered (or cleared) when the host changes.
    if (body.providerBaseUrl !== undefined && body.apiKey === undefined && currentRow.api_key_ciphertext) {
      const hostOf = (u: string) => {
        try {
          return new URL(u).hostname.toLowerCase();
        } catch {
          return u;
        }
      };
      if (hostOf(body.providerBaseUrl) !== hostOf(currentRow.provider_base_url)) {
        return reply.code(400).send({
          error: {
            code: "key_required",
            message: "Re-enter the API key when changing the provider host.",
            details: {},
          },
        });
      }
    }

    if (body.maxCompletionTokens !== undefined) {
      const tokens = Number(body.maxCompletionTokens);
      if (!Number.isInteger(tokens) || tokens < 50 || tokens > 800) {
        return reply.code(400).send({
          error: {
            code: "validation",
            message: "maxCompletionTokens must be an integer between 50 and 800.",
            details: {},
          },
        });
      }
    }

    if (body.model !== undefined) {
      if (typeof body.model !== "string" || !body.model.trim()) {
        return reply.code(400).send({
          error: {
            code: "validation",
            message: "model must be a non-empty string.",
            details: {},
          },
        });
      }
    }

    const newMode = body.mode !== undefined ? body.mode : currentRow.mode;
    const newInstructions =
      body.systemInstructions !== undefined
        ? body.systemInstructions
        : currentRow.system_instructions;
    const newBaseUrl =
      body.providerBaseUrl !== undefined ? body.providerBaseUrl : currentRow.provider_base_url;
    const newModel = body.model !== undefined ? body.model.trim() : currentRow.model;
    const newMaxTokens =
      body.maxCompletionTokens !== undefined
        ? Number(body.maxCompletionTokens)
        : currentRow.max_completion_tokens;

    let newCiphertext = currentRow.api_key_ciphertext;
    let newNonce = currentRow.api_key_nonce;
    let newLast4 = currentRow.api_key_last4;

    if (body.apiKey !== undefined) {
      const keyStr = body.apiKey.trim();
      if (keyStr === "") {
        newCiphertext = null;
        newNonce = null;
        newLast4 = null;
      } else {
        const encrypted = encryptApiKey(keyStr);
        newCiphertext = encrypted.ciphertext;
        newNonce = encrypted.nonce;
        newLast4 = encrypted.last4;
      }
    }

    const now = Date.now();
    await db.prepare(`
      UPDATE ai_settings
      SET
        mode = ?,
        system_instructions = ?,
        provider_base_url = ?,
        model = ?,
        max_completion_tokens = ?,
        api_key_ciphertext = ?,
        api_key_nonce = ?,
        api_key_last4 = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      newMode,
      newInstructions,
      newBaseUrl,
      newModel,
      newMaxTokens,
      newCiphertext,
      newNonce,
      newLast4,
      now
    );

    const updatedRow = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as AiSettingsRow;
    return reply.code(200).send(formatAiSettingsResponse(updatedRow));
  });

  // POST /ai-settings/probe
  app.post("/ai-settings/probe", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const now = Date.now();

    if (!checkProbeRateLimit(now)) {
      return reply.code(429).send({
        error: {
          code: "rate_limited",
          message: "Probe rate limit exceeded (5 per hour).",
          details: {},
        },
      });
    }

    const db = app.db;
    const row = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as AiSettingsRow;

    if (!row.api_key_ciphertext || !row.api_key_nonce) {
      return reply.code(502).send({
        ok: false,
        error: {
          code: "ai_error",
          message: "provider rejected the key",
        },
      });
    }

    let apiKey: string;
    try {
      apiKey = decryptApiKey(row.api_key_ciphertext, row.api_key_nonce);
    } catch (err: any) {
      return reply.code(409).send({
        ok: false,
        error: {
          code: "key_undecryptable",
          message: err?.message || "The stored API key cannot be decrypted. Re-enter the key.",
        },
      });
    }

    try {
      const probeResult = await probeAiConnection(
        {
          providerBaseUrl: row.provider_base_url,
          model: row.model,
          maxCompletionTokens: row.max_completion_tokens,
          systemInstructions: row.system_instructions,
        },
        apiKey
      );

      return reply.code(200).send({
        ok: true,
        model: probeResult.model,
        ms: probeResult.ms,
      });
    } catch (err: any) {
      return reply.code(502).send({
        ok: false,
        error: describeProviderError(err),
      });
    }
  });
};

/**
 * Map a provider/SDK error to a fixed, operator-friendly message. Raw provider text can
 * include key fragments or internal details, so it is never forwarded verbatim.
 */
function describeProviderError(err: any): { code: string; message: string } {
  if (err?.code === "reasoning_not_reported") {
    return { code: "reasoning_not_reported", message: "Model did not report reasoning tokens." };
  }
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 401 || status === 403) return { code: "ai_error", message: "provider rejected the key" };
  if (status === 404) return { code: "ai_error", message: "model or endpoint not found at the provider" };
  if (status === 429) return { code: "ai_error", message: "provider rate limit or quota exceeded" };
  if (status && status >= 500) return { code: "ai_error", message: `provider error (HTTP ${status})` };
  if (err?.name === "AbortError" || err?.name === "TimeoutError" || /timed? ?out/i.test(String(err?.message))) {
    return { code: "ai_timeout", message: "provider did not answer within 25 seconds" };
  }
  const msg = String(err?.message ?? "");
  if (/not in the allowed AI hosts|Private, loopback|Only https|Non-standard ports|Userinfo|resolve AI host|private address|Empty reply/.test(msg)) {
    return { code: "ai_error", message: msg };
  }
  return { code: "ai_error", message: status ? `provider request failed (HTTP ${status})` : "could not reach the provider" };
}

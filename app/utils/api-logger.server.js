// app/utils/api-logger.server.js

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/* -------------------------------------------------------------------------- */
/*                                  Config                                    */
/* -------------------------------------------------------------------------- */

const LOG_DIR =
  process.env.API_LOG_DIR ||
  path.join(
    process.cwd(),
    "logs",
  );

/* -------------------------------------------------------------------------- */
/*                              Helper functions                              */
/* -------------------------------------------------------------------------- */

function getDateKey() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function getLogFilePath() {
  return path.join(
    LOG_DIR,
    `api-${getDateKey()}.log`,
  );
}

function getClientIp(
  request,
) {
  const forwardedFor =
    request.headers.get(
      "x-forwarded-for",
    );

  if (forwardedFor) {
    return forwardedFor
      .split(",")[0]
      .trim();
  }

  return (
    request.headers.get(
      "cf-connecting-ip",
    ) ||
    request.headers.get(
      "x-real-ip",
    ) ||
    null
  );
}

function maskSensitiveValue(
  key,
  value,
) {
  const sensitiveKeys = [
    "password",
    "token",
    "secret",
    "authorization",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "credit_card",
    "card_number",
    "cvv",
  ];

  const normalizedKey =
    String(key || "")
      .toLowerCase()
      .replace(/[-\s]/g, "_");

  if (
    sensitiveKeys.some(
      (item) =>
        normalizedKey.includes(
          item,
        ),
    )
  ) {
    return "[REDACTED]";
  }

  return value;
}

function sanitizeObject(
  value,
) {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return value;
  }

  if (
    Array.isArray(value)
  ) {
    return value.map(
      sanitizeObject,
    );
  }

  const result = {};

  for (
    const [key, item]
    of Object.entries(value)
  ) {
    const masked =
      maskSensitiveValue(
        key,
        item,
      );

    result[key] =
      masked ===
      "[REDACTED]"
        ? masked
        : sanitizeObject(
            masked,
          );
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*                              Write log entry                               */
/* -------------------------------------------------------------------------- */

async function writeLog(
  entry,
) {
  try {
    await fs.mkdir(
      LOG_DIR,
      {
        recursive:
          true,
      },
    );

    const filePath =
      getLogFilePath();

    await fs.appendFile(
      filePath,
      `${JSON.stringify(
        entry,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    /*
     * Logging failure should never break
     * the actual API request.
     */
    console.error(
      "API file logging failed:",
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              Start request log                             */
/* -------------------------------------------------------------------------- */

export async function startApiRequestLog(
  request,
  {
    route = null,
    shop = null,
  } = {},
) {
  const requestId =
    request.headers.get(
      "x-request-id",
    ) ||
    crypto.randomUUID();

  const startedAt =
    Date.now();

  const url =
    new URL(
      request.url,
    );

  const entry = {
    type:
      "api_request_started",

    requestId,

    timestamp:
      new Date().toISOString(),

    method:
      request.method,

    route:
      route ||
      url.pathname,

    pathname:
      url.pathname,

    query:
      Object.fromEntries(
        url.searchParams.entries(),
      ),

    shop,

    ip:
      getClientIp(
        request,
      ),

    userAgent:
      request.headers.get(
        "user-agent",
      ),

    contentType:
      request.headers.get(
        "content-type",
      ),
  };

  await writeLog(
    entry,
  );

  return {
    requestId,
    startedAt,
  };
}

/* -------------------------------------------------------------------------- */
/*                             Complete request log                           */
/* -------------------------------------------------------------------------- */

export async function completeApiRequestLog({
  requestId,
  startedAt,
  status,
  route = null,
  shop = null,
  response = null,
  metadata = null,
}) {
  const finishedAt =
    Date.now();

  await writeLog({
    type:
      "api_request_completed",

    requestId,

    timestamp:
      new Date().toISOString(),

    route,

    shop,

    status,

    durationMs:
      finishedAt -
      startedAt,

    response:
      response
        ? sanitizeObject(
            response,
          )
        : null,

    metadata:
      metadata
        ? sanitizeObject(
            metadata,
          )
        : null,
  });
}

/* -------------------------------------------------------------------------- */
/*                               Error request log                            */
/* -------------------------------------------------------------------------- */

export async function errorApiRequestLog({
  requestId,
  startedAt,
  route = null,
  shop = null,
  error,
  metadata = null,
}) {
  const finishedAt =
    Date.now();

  await writeLog({
    type:
      "api_request_failed",

    requestId,

    timestamp:
      new Date().toISOString(),

    route,

    shop,

    status:
      500,

    durationMs:
      finishedAt -
      startedAt,

    error: {
      name:
        error instanceof Error
          ? error.name
          : "Error",

      message:
        error instanceof Error
          ? error.message
          : String(
              error,
            ),

      stack:
        process.env.NODE_ENV ===
        "development"
          ? error instanceof Error
            ? error.stack
            : null
          : undefined,
    },

    metadata:
      metadata
        ? sanitizeObject(
            metadata,
          )
        : null,
  });
}

/* -------------------------------------------------------------------------- */
/*                                Custom log                                  */
/* -------------------------------------------------------------------------- */

export async function apiLog(
  type,
  data = {},
) {
  await writeLog({
    type,

    timestamp:
      new Date().toISOString(),

    ...sanitizeObject(
      data,
    ),
  });
}
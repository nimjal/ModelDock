/**
 * The one error type routes throw.
 *
 * Everything else that escapes a handler is a bug, and is reported as a 500
 * with a generic message — a stack trace has no business reaching the page.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(error: unknown, c: Context): Response {
  if (error instanceof HttpError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("[modeldock]", error);
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return c.json({ error: message }, 500);
}

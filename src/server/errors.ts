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

/**
 * The error shape OpenAI and Anthropic clients actually parse.
 *
 * Both vendors nest the message in an object, and every client library built
 * against them reads `error.message`. ModelDock's own page reads a bare
 * `error` string, and it would be wrong to change that — so the gateway gets
 * the vendor envelope and `/api` keeps its own.
 *
 * Without this, a model-not-found or a missing key surfaces inside Claude Code
 * as `undefined`, which is the least useful thing a 404 can say: the message on
 * the other side of it names the model and tells you how to list the real ones.
 */
function vendorError(
  status: number,
  message: string,
): { error: { type: string; message: string } } {
  const type =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 404
        ? "not_found_error"
        : status === 400
          ? "invalid_request_error"
          : "api_error";

  return { error: { type, message } };
}

export function errorResponse(error: unknown, c: Context): Response {
  // `/v1` is two other vendors' protocols, so a failure there has to be
  // legible to their clients rather than to this app's page.
  const gateway = new URL(c.req.url).pathname.startsWith("/v1");

  if (error instanceof HttpError) {
    return c.json(
      gateway ? vendorError(error.status, error.message) : { error: error.message },
      error.status,
    );
  }

  console.error("[modeldock]", error);
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return c.json(gateway ? vendorError(500, message) : { error: message }, 500);
}

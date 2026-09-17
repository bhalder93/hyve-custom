import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

/**
 * Server-side error logging.
 *
 * React Router calls this for every error raised while handling a request —
 * including ones it generates before your route runs, such as the 7.18 CSRF
 * origin check that rejects action submissions with a bare "Bad Request".
 * Logging the `origin` header is what makes that failure diagnosable: whatever
 * it prints is the value that belongs in `allowedActionOrigins`
 * (react-router.config.js).
 */
export function handleError(error, { request }) {
  if (request.signal.aborted) return;

  console.error(
    `[server] ${request.method} ${request.url} failed: ${error?.message || error}`,
    { origin: request.headers.get("origin") || "(none)" },
  );
  if (error?.stack) console.error(error.stack);
}

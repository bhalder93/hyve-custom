// app/routes/api.sla-cron.jsx

import {
  unauthenticated,
} from "../shopify.server";

import {
  runSlaEngine,
} from "../utils/sla-engine.server";

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */
import {
  startApiRequestLog,
  completeApiRequestLog,
  errorApiRequestLog,
} from "../utils/api-logger.server";

function getBearerToken(request) {
  const authorization =
    request.headers.get(
      "authorization",
    );

    console.log(authorization)
  if (!authorization) {
    return "";
  }

  const [
    scheme,
    token,
  ] =
    authorization.split(" ");

  if (
    scheme?.toLowerCase() !==
    "bearer"
  ) {
    return "";
  }

  return token || "";
}

function secureCompare(
  provided,
  expected,
) {
  if (
    !provided ||
    !expected ||
    provided.length !==
      expected.length
  ) {
    return false;
  }

  let result = 0;

  for (
    let index = 0;
    index < provided.length;
    index += 1
  ) {
    result |=
      provided.charCodeAt(
        index,
      ) ^
      expected.charCodeAt(
        index,
      );
  }

  return result === 0;
}

function authorizeCron(
  request,
) {
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    throw new Error(
      "CRON_SECRET is not configured.",
    );
  }

  const providedSecret =
    getBearerToken(
      request,
    );

  return secureCompare(
    providedSecret,
    expectedSecret,
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Loader                                   */
/* -------------------------------------------------------------------------- */

export async function loader() {
  return new Response(
    JSON.stringify({
      service:
        "Hyve SLA Engine",
      status:
        "available",
    }),
    {
      status: 200,

      headers: {
        "Content-Type":
          "application/json",
      },
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Action                                   */
/* -------------------------------------------------------------------------- */

export async function action({
  request,
}) {
  const log =
    await startApiRequestLog(
      request,
      {
        route:
          "/api/sla-cron",
      },
    );

  let shop = null;

  try {
    /* -------------------------------------------------------------------- */
    /* Authorization                                                        */
    /* -------------------------------------------------------------------- */

    const authorization =
      request.headers.get(
        "authorization",
      );

    const expectedSecret =
      process.env
        .CRON_SECRET;

    if (!expectedSecret) {
      const response = {
        success:
          false,

        error:
          "CRON_SECRET is not configured.",
      };

      await completeApiRequestLog({
        ...log,

        route:
          "/api/sla-cron",

        status:
          500,

        response,
      });

      return new Response(
        JSON.stringify(
          response,
        ),
        {
          status: 500,

          headers: {
            "Content-Type":
              "application/json",
          },
        },
      );
    }

    if (
      authorization !==
      `Bearer ${expectedSecret}`
    ) {
      const response = {
        success:
          false,

        error:
          "Unauthorized",
      };

      await completeApiRequestLog({
        ...log,

        route:
          "/api/sla-cron",

        status:
          401,

        response,
      });

      return new Response(
        JSON.stringify(
          response,
        ),
        {
          status: 401,

          headers: {
            "Content-Type":
              "application/json",
          },
        },
      );
    }

    /* -------------------------------------------------------------------- */
    /* Shop                                                                 */
    /* -------------------------------------------------------------------- */

    shop =
      process.env
        .SHOPIFY_SHOP
        ?.trim()
        .toLowerCase();

    if (!shop) {
      throw new Error(
        "SHOPIFY_SHOP is missing.",
      );
    }

    if (
      !shop.endsWith(
        ".myshopify.com",
      )
    ) {
      throw new Error(
        `Invalid SHOPIFY_SHOP "${shop}".`,
      );
    }

    /* -------------------------------------------------------------------- */
    /* Shopify Admin                                                        */
    /* -------------------------------------------------------------------- */

    const {
      admin,
    } =
      await unauthenticated.admin(
        shop,
      );

    /* -------------------------------------------------------------------- */
    /* SLA                                                                  */
    /* -------------------------------------------------------------------- */

    const summary =
      await runSlaEngine(
        admin,
      );

    const response = {
      success:
        true,

      summary,
    };

    await completeApiRequestLog({
      ...log,

      route:
        "/api/sla-cron",

      shop,

      status:
        200,

      response,

      metadata: {
        checked:
          summary.checked,

        productionOrdersChecked:
          summary
            .productionOrdersChecked,

        blankOrdersSkipped:
          summary
            .blankOrdersSkipped,

        alertsSent:
          summary
            .alertsSent,

        remindersSent:
          summary
            .remindersSent,

        errors:
          summary.errors
            ?.length ||
          0,
      },
    });

    return new Response(
      JSON.stringify(
        response,
      ),
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/json",

          "X-Request-ID":
            log.requestId,
        },
      },
    );
  } catch (error) {
    console.error(
      "SLA cron execution failed:",
      error,
    );

    await errorApiRequestLog({
      ...log,

      route:
        "/api/sla-cron",

      shop,

      error,
    });

    return new Response(
      JSON.stringify({
        success:
          false,

        requestId:
          log.requestId,

        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      }),
      {
        status: 500,

        headers: {
          "Content-Type":
            "application/json",

          "X-Request-ID":
            log.requestId,
        },
      },
    );
  }
}
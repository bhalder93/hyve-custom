
// app/routes/webhooks.orders.create.jsx

import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function action({ request }) {
  try {
    console.log(
      "================ ORDERS_CREATE WEBHOOK ================"
    );

    const {
      topic,
      shop,
      payload,
    } = await authenticate.webhook(request);

    console.log("Webhook topic:", topic);
    console.log("Shop:", shop);
    console.log("Order ID:", payload?.id);
    console.log("Order name:", payload?.name);

    if (topic !== "ORDERS_CREATE") {
      console.warn(
        "Unexpected webhook topic:",
        topic
      );

      return new Response("Ignored", {
        status: 200,
      });
    }

    if (!shop) {
      console.error(
        "Shop is missing from webhook"
      );

      return new Response("Shop missing", {
        status: 200,
      });
    }

    if (!payload?.id) {
      console.error(
        "Order ID is missing from webhook payload"
      );

      return new Response("Order ID missing", {
        status: 200,
      });
    }

    console.log(
      "Checking offline Prisma session..."
    );

    const storedSession = await db.session.findFirst({
      where: {
        shop,
        isOnline: false,
      },
      select: {
        id: true,
        shop: true,
        state: true,
        isOnline: true,
        scope: true,
        expires: true,
        accessToken: true,
      },
    });

    if (!storedSession) {
      console.error(
        `No offline Shopify session found for ${shop}`
      );

      return new Response(
        "Shopify offline session not found",
        {
          status: 200,
        }
      );
    }

    console.log(
      "Offline session found:",
      {
        id: storedSession.id,
        shop: storedSession.shop,
        isOnline: storedSession.isOnline,
        scope: storedSession.scope,
        expires: storedSession.expires,
      }
    );

    if (!storedSession.accessToken) {
      console.error(
        `Offline session exists but accessToken is missing for ${shop}`
      );

      return new Response(
        "Shopify access token missing",
        {
          status: 200,
        }
      );
    }

    console.log(
      "Creating Shopify Admin context..."
    );

    /*
     * authenticate.admin() must NOT be called here.
     *
     * This is a Shopify webhook request, not an
     * Admin UI request.
     *
     * The Admin context should come from the
     * webhook authentication/session configuration.
     */

    const { admin } = await authenticate.webhook(
      request
    );

    if (!admin) {
      console.error(
        `Could not create Admin API context for ${shop}`
      );

      return new Response(
        "Shopify Admin API unavailable",
        {
          status: 200,
        }
      );
    }

    console.log(
      "Shopify Admin API context created"
    );

    const mutation = `#graphql
      mutation AddTagToOrder(
        $id: ID!,
        $tags: [String!]!
      ) {
        tagsAdd(
          id: $id,
          tags: $tags
        ) {
          node {
            id
          }

          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      id: payload.id,
      tags: ["my-custom-tag"],
    };

    console.log(
      "Calling Shopify GraphQL..."
    );

    const response = await admin.graphql(
      mutation,
      {
        variables,
      }
    );

    const result = await response.json();

    console.log(
      "Shopify GraphQL response:",
      JSON.stringify(
        result,
        null,
        2
      )
    );

    if (result?.errors?.length) {
      console.error(
        "Shopify GraphQL errors:",
        JSON.stringify(
          result.errors,
          null,
          2
        )
      );

      return new Response(
        "Shopify GraphQL error",
        {
          status: 200,
        }
      );
    }

    const userErrors =
      result?.data?.tagsAdd?.userErrors || [];

    if (userErrors.length > 0) {
      console.error(
        "tagsAdd user errors:",
        JSON.stringify(
          userErrors,
          null,
          2
        )
      );

      return new Response(
        "Unable to add order tag",
        {
          status: 200,
        }
      );
    }

    console.log(
      `Successfully added my-custom-tag to ${payload.name}`
    );

    console.log(
      "================ WEBHOOK COMPLETE ================"
    );

    return new Response("OK", {
      status: 200,
    });
  } catch (error) {
    console.error(
      "================ WEBHOOK ERROR ================"
    );

    console.error(
      "Error processing ORDERS_CREATE webhook:"
    );

    console.error(error);

    return new Response(
      "Webhook processing failed",
      {
        status: 500,
      }
    );
  }
}

export function loader() {
  return new Response(
    "Method Not Allowed",
    {
      status: 405,
    }
  );
}


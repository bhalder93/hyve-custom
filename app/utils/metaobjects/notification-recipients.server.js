export const NOTIFICATION_RECIPIENT_TYPE =
  "$app:notification_recipient";

export const RECIPIENT_ROLES = [
  {
    label: "Customer Service",
    value: "CUSTOMER_SERVICE",
  },
  {
    label: "Artwork Coordinator",
    value: "ARTWORK_COORDINATOR",
  },
  {
    label: "Production",
    value: "PRODUCTION",
  },
  {
    label: "Management",
    value: "MANAGEMENT",
  },
];

export async function getNotificationRecipients(admin) {
  const response = await admin.graphql(
    `#graphql
      query GetNotificationRecipients {
        metaobjects(
          type: "$app:notification_recipient"
          first: 100
        ) {
          nodes {
            id
            handle

            name: field(key: "name") {
              value
            }

            role: field(key: "role") {
              value
            }

            email: field(key: "email") {
              value
            }

            enabled: field(key: "enabled") {
              value
            }
          }
        }
      }
    `,
  );

  const json = await response.json();

  if (json.errors?.length) {
    console.error(
      "Get notification recipients GraphQL errors:",
      json.errors,
    );

    throw new Error(
      json.errors
        .map((error) => error.message)
        .join(", "),
    );
  }

  return (json.data?.metaobjects?.nodes ?? [])
    .map((node) => ({
      id: node.id,
      handle: node.handle,

      name: node.name?.value ?? "",

      role: node.role?.value ?? "",

      email: node.email?.value ?? "",

      enabled: node.enabled?.value !== "false",
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name),
    );
}

export async function upsertNotificationRecipient(
  admin,
  recipient,
) {
  const response = await admin.graphql(
    `#graphql
      mutation UpsertNotificationRecipient(
        $handle: MetaobjectHandleInput!
        $metaobject: MetaobjectUpsertInput!
      ) {
        metaobjectUpsert(
          handle: $handle
          metaobject: $metaobject
        ) {
          metaobject {
            id
            handle
          }

          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      variables: {
        handle: {
          type: NOTIFICATION_RECIPIENT_TYPE,
          handle: recipient.handle,
        },

        metaobject: {
          fields: [
            {
              key: "name",
              value: recipient.name,
            },
            {
              key: "role",
              value: recipient.role,
            },
            {
              key: "email",
              value: recipient.email,
            },
            {
              key: "enabled",
              value: String(
                Boolean(recipient.enabled),
              ),
            },
          ],
        },
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    console.error(
      "Recipient GraphQL errors:",
      json.errors,
    );

    throw new Error(
      json.errors
        .map((error) => error.message)
        .join(", "),
    );
  }

  const userErrors =
    json.data?.metaobjectUpsert?.userErrors ??
    [];

  if (userErrors.length > 0) {
    console.error(
      "Recipient user errors:",
      userErrors,
    );

    throw new Error(
      userErrors
        .map((error) => error.message)
        .join(", "),
    );
  }

  return json.data.metaobjectUpsert.metaobject;
}

export async function deleteNotificationRecipient(
  admin,
  id,
) {
  const response = await admin.graphql(
    `#graphql
      mutation DeleteNotificationRecipient(
        $id: ID!
      ) {
        metaobjectDelete(id: $id) {
          deletedId

          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      variables: {
        id,
      },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    console.error(
      "Delete recipient GraphQL errors:",
      json.errors,
    );

    throw new Error(
      json.errors
        .map((error) => error.message)
        .join(", "),
    );
  }

  const userErrors =
    json.data?.metaobjectDelete?.userErrors ??
    [];

  if (userErrors.length > 0) {
    throw new Error(
      userErrors
        .map((error) => error.message)
        .join(", "),
    );
  }

  return json.data.metaobjectDelete.deletedId;
}

export function createRecipientHandle({
  role,
  email,
}) {
  const normalizedEmail = String(email)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${String(role)
    .toLowerCase()
    .replace(/_/g, "-")}-${normalizedEmail}`.slice(
    0,
    240,
  );
}
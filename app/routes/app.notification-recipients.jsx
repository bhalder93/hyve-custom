// app/routes/app.notification-recipients.jsx

import { useEffect, useMemo, useState } from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";

import { authenticate } from "../shopify.server";
const RECIPIENT_TYPE = "$app:notification_recipient";

const ROLE_OPTIONS = [
  {
    value: "CUSTOMER_SERVICE",
    label: "Customer Service",
    description:
      "Receives artwork, proof approval, On Hold and delivery scan alerts.",
  },
  {
    value: "ARTWORK_COORDINATOR",
    label: "Artwork Coordinator",
    description: "Receives proof-not-sent artwork alerts.",
  },
  {
    value: "PRODUCTION",
    label: "Production",
    description: "Receives production, shipping and delivery SLA alerts.",
  },
  {
    value: "MANAGEMENT",
    label: "Management",
    description: "Optional management visibility. Not used by default.",
  },
];

const VALID_ROLES = new Set(ROLE_OPTIONS.map((item) => item.value));

function getRoleLabel(role) {
  return (
    ROLE_OPTIONS.find((item) => item.value === role)?.label || role || "Unknown"
  );
}

function roleTone(role) {
  switch (role) {
    case "CUSTOMER_SERVICE":
      return "info";

    case "ARTWORK_COORDINATOR":
      return "warning";

    case "PRODUCTION":
      return "success";

    case "MANAGEMENT":
      return "neutral";

    default:
      return "neutral";
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validateRecipient({ name, role, email }) {
  const errors = {};

  if (!name?.trim()) {
    errors.name = "Recipient name is required.";
  }

  if (!role) {
    errors.role = "Select a recipient role.";
  } else if (!VALID_ROLES.has(role)) {
    errors.role = "Invalid recipient role.";
  }

  if (!email?.trim()) {
    errors.email = "Email address is required.";
  } else if (!isValidEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  return errors;
}

async function parseGraphQL(response, operationName) {
  const data = await response.json();

  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);

    throw new Error(data.errors.map((error) => error.message).join(", "));
  }

  return data;
}

function throwUserErrors(errors, operationName) {
  if (!errors?.length) {
    return;
  }

  console.error(`${operationName} user errors:`, errors);

  throw new Error(errors.map((error) => error.message).join(", "));
}

function normalizeRecipient(node) {
  return {
    id: node.id,

    handle: node.handle || "",

    name: node.name?.value || "",

    role: node.role?.value || "",

    email: node.email?.value || "",

    enabled: node.enabled?.value !== "false",

    updatedAt: node.updatedAt || "",
  };
}

async function getRecipients(admin) {
  const response = await admin.graphql(
    `#graphql
        query NotificationRecipients {
          metaobjects(
            type: "$app:notification_recipient"
            first: 250
            sortKey: "display_name"
          ) {
            nodes {
              id
              handle
              updatedAt

              name: field(
                key: "name"
              ) {
                value
              }

              role: field(
                key: "role"
              ) {
                value
              }

              email: field(
                key: "email"
              ) {
                value
              }

              enabled: field(
                key: "enabled"
              ) {
                value
              }
            }
          }
        }
      `,
  );

  const data = await parseGraphQL(response, "NotificationRecipients");

  return (data.data?.metaobjects?.nodes ?? []).map(normalizeRecipient);
}

async function getRecipientById(admin, id) {
  const response = await admin.graphql(
    `#graphql
        query NotificationRecipient(
          $id: ID!
        ) {
          metaobject(id: $id) {
            id
            handle

            name: field(
              key: "name"
            ) {
              value
            }

            role: field(
              key: "role"
            ) {
              value
            }

            email: field(
              key: "email"
            ) {
              value
            }

            enabled: field(
              key: "enabled"
            ) {
              value
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

  const data = await parseGraphQL(response, "NotificationRecipient");

  const node = data.data?.metaobject;

  if (!node) {
    throw new Error("Notification recipient not found.");
  }

  return normalizeRecipient(node);
}

async function createRecipient(admin, { name, role, email, enabled }) {
  const response = await admin.graphql(
    `#graphql
        mutation CreateNotificationRecipient(
          $metaobject: MetaobjectCreateInput!
        ) {
          metaobjectCreate(
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
        metaobject: {
          type: RECIPIENT_TYPE,

          fields: [
            {
              key: "name",
              value: name.trim(),
            },
            {
              key: "role",
              value: role,
            },
            {
              key: "email",
              value: email.trim().toLowerCase(),
            },
            {
              key: "enabled",
              value: String(Boolean(enabled)),
            },
          ],
        },
      },
    },
  );

  const data = await parseGraphQL(response, "CreateNotificationRecipient");

  throwUserErrors(
    data.data?.metaobjectCreate?.userErrors,
    "CreateNotificationRecipient",
  );

  return data.data?.metaobjectCreate?.metaobject || null;
}

async function updateRecipient(admin, { id, name, role, email, enabled }) {
  const response = await admin.graphql(
    `#graphql
        mutation UpdateNotificationRecipient(
          $id: ID!
          $metaobject: MetaobjectUpdateInput!
        ) {
          metaobjectUpdate(
            id: $id
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
        id,

        metaobject: {
          fields: [
            {
              key: "name",
              value: name.trim(),
            },
            {
              key: "role",
              value: role,
            },
            {
              key: "email",
              value: email.trim().toLowerCase(),
            },
            {
              key: "enabled",
              value: String(Boolean(enabled)),
            },
          ],
        },
      },
    },
  );

  const data = await parseGraphQL(response, "UpdateNotificationRecipient");

  throwUserErrors(
    data.data?.metaobjectUpdate?.userErrors,
    "UpdateNotificationRecipient",
  );

  return data.data?.metaobjectUpdate?.metaobject || null;
}

async function deleteRecipient(admin, id) {
  const response = await admin.graphql(
    `#graphql
        mutation DeleteNotificationRecipient(
          $id: ID!
        ) {
          metaobjectDelete(
            id: $id
          ) {
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

  const data = await parseGraphQL(response, "DeleteNotificationRecipient");

  throwUserErrors(
    data.data?.metaobjectDelete?.userErrors,
    "DeleteNotificationRecipient",
  );

  return data.data?.metaobjectDelete?.deletedId || null;
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const recipients = await getRecipients(admin);

    return {
      recipients,
      loaderError: null,
    };
  } catch (error) {
    console.error("Notification recipients loader error:", error);

    return {
      recipients: [],

      loaderError:
        error instanceof Error
          ? error.message
          : "Unable to load notification recipients.",
    };
  }
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "").trim();
    if (intent === "delete") {
      const id = String(formData.get("id") || "").trim();

      if (!id) {
        return {
          success: false,
          fieldErrors: {},
          formError: "Recipient ID is missing.",
        };
      }

      await deleteRecipient(admin, id);

      return {
        success: true,

        message: "Notification recipient deleted.",

        fieldErrors: {},
        formError: null,
      };
    }
    if (intent === "toggle") {
      const id = String(formData.get("id") || "").trim();

      if (!id) {
        return {
          success: false,
          fieldErrors: {},
          formError: "Recipient ID is missing.",
        };
      }

      const existing = await getRecipientById(admin, id);

      await updateRecipient(admin, {
        ...existing,

        enabled: !existing.enabled,
      });

      return {
        success: true,

        message: existing.enabled
          ? `${existing.name} disabled.`
          : `${existing.name} enabled.`,

        fieldErrors: {},
        formError: null,
      };
    }

    if (intent !== "create" && intent !== "update") {
      return {
        success: false,

        fieldErrors: {},

        formError: "Unsupported action.",
      };
    }

    const id = String(formData.get("id") || "").trim();

    const name = String(formData.get("name") || "").trim();

    const role = String(formData.get("role") || "").trim();

    const email = String(formData.get("email") || "").trim();

    const enabled = String(formData.get("enabled") || "") === "true";

    const fieldErrors = validateRecipient({
      name,
      role,
      email,
    });

    if (Object.keys(fieldErrors).length) {
      return {
        success: false,

        fieldErrors,

        formError: "Please correct the highlighted fields.",
      };
    }

    if (intent === "create") {
      await createRecipient(admin, {
        name,
        role,
        email,
        enabled,
      });

      return {
        success: true,

        message: "Notification recipient created.",

        fieldErrors: {},
        formError: null,
      };
    }

    if (!id) {
      return {
        success: false,

        fieldErrors: {},

        formError: "Recipient ID is missing.",
      };
    }

    await updateRecipient(admin, {
      id,
      name,
      role,
      email,
      enabled,
    });

    return {
      success: true,

      message: "Notification recipient updated.",

      fieldErrors: {},
      formError: null,
    };
  } catch (error) {
    console.error("Notification recipient action error:", error);

    return {
      success: false,

      fieldErrors: {},

      formError:
        error instanceof Error
          ? error.message
          : "Unable to update notification recipient.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                               Recipient editor                             */
/* -------------------------------------------------------------------------- */

function RecipientEditor({
  name,
  email,
  role,
  enabled,
  errors,
  busy,
  isEditing,
  onNameChange,
  onEmailChange,
  onRoleChange,
  onEnabledChange,
  onSave,
  onDelete,
}) {
  const roleDescription =
    ROLE_OPTIONS.find(
      (item) =>
        item.value === role,
    )?.description || "";

  return (
    <s-stack
      direction="block"
      gap="base"
    >
      <s-grid
        gridTemplateColumns="repeat(2, minmax(0, 1fr))"
        gap="base"
      >
        <s-text-field
          label="Name"
          value={name}
          placeholder="Bruce Wan"
          error={
            errors?.name ||
            undefined
          }
          onInput={(event) =>
            onNameChange(
              event.currentTarget.value,
            )
          }
        />

        <s-text-field
          label="Email"
          type="email"
          value={email}
          placeholder="bruce@hyve.promo"
          error={
            errors?.email ||
            undefined
          }
          onInput={(event) =>
            onEmailChange(
              event.currentTarget.value,
            )
          }
        />
      </s-grid>

      <s-select
        label="Role"
        value={role}
        error={
          errors?.role ||
          undefined
        }
        onChange={(event) =>
          onRoleChange(
            event.currentTarget.value,
          )
        }
      >
        {ROLE_OPTIONS.map(
          (item) => (
            <s-option
              key={item.value}
              value={item.value}
            >
              {item.label}
            </s-option>
          ),
        )}
      </s-select>

      {roleDescription && (
        <s-banner tone="info">
          <s-paragraph>
            {roleDescription}
          </s-paragraph>
        </s-banner>
      )}

      <s-checkbox
        label="Enabled"
        checked={enabled}
        onChange={(event) =>
          onEnabledChange(
            event.currentTarget.checked,
          )
        }
      />

      <s-divider />

      <s-stack
        direction="inline"
        justifyContent="space-between"
        gap="base"
      >
        <div>
          {isEditing && (
            <s-button
              tone="critical"
              disabled={busy}
              commandFor="recipient-delete-modal"
              command="--show"
              onClick={
                onDelete
              }
            >
              Delete
            </s-button>
          )}
        </div>

        <s-button
          variant="primary"
          disabled={busy}
          onClick={onSave}
        >
          {busy
            ? "Saving..."
            : isEditing
              ? "Save changes"
              : "Add recipient"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function NotificationRecipientsPage() {
  const loaderData =
    useLoaderData();

  const actionData =
    useActionData();

  const navigation =
    useNavigation();

  const submit =
    useSubmit();

  const recipients =
    loaderData?.recipients ||
    [];

  const [
    editingId,
    setEditingId,
  ] =
    useState(null);

  const [
    name,
    setName,
  ] =
    useState("");

  const [
    email,
    setEmail,
  ] =
    useState("");

  const [
    role,
    setRole,
  ] =
    useState(
      "CUSTOMER_SERVICE",
    );

  const [
    enabled,
    setEnabled,
  ] =
    useState(true);

  const [
    clientErrors,
    setClientErrors,
  ] =
    useState({});

  const [
    deleteTarget,
    setDeleteTarget,
  ] =
    useState(null);

  const busy =
    navigation.state !==
    "idle";

  const submittingIntent =
    useMemo(() => {
      if (
        navigation.state ===
        "idle"
      ) {
        return null;
      }

      return (
        navigation.formData?.get(
          "intent",
        ) || null
      );
    }, [
      navigation,
    ]);

  const submittingId =
    useMemo(() => {
      if (
        navigation.state ===
        "idle"
      ) {
        return null;
      }

      return (
        navigation.formData?.get(
          "id",
        ) || null
      );
    }, [
      navigation,
    ]);

  const isEditing =
    Boolean(editingId);

  const deleting =
    busy &&
    submittingIntent ===
      "delete" &&
    deleteTarget &&
    submittingId ===
      deleteTarget.id;

  /* ---------------------------------------------------------------------- */
  /* Reset                                                                  */
  /* ---------------------------------------------------------------------- */

  function resetForm() {
    setEditingId(null);

    setName("");

    setEmail("");

    setRole(
      "CUSTOMER_SERVICE",
    );

    setEnabled(true);

    setClientErrors({});
  }

  /* ---------------------------------------------------------------------- */
  /* Action result                                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (
      !actionData?.success
    ) {
      return;
    }

    if (
      actionData.message
    ) {
      shopify.toast.show(
        actionData.message,
      );
    }

    if (
      actionData.intent ===
        "create" ||
      actionData.intent ===
        "update"
    ) {
      document
        .getElementById(
          "recipient-editor-modal",
        )
        ?.hideOverlay?.();

      resetForm();
    }

    if (
      actionData.intent ===
      "delete"
    ) {
      document
        .getElementById(
          "recipient-delete-modal",
        )
        ?.hideOverlay?.();

      document
        .getElementById(
          "recipient-editor-modal",
        )
        ?.hideOverlay?.();

      setDeleteTarget(
        null,
      );

      resetForm();
    }
  }, [
    actionData,
  ]);

  /* ---------------------------------------------------------------------- */
  /* Open create                                                            */
  /* ---------------------------------------------------------------------- */

  function openCreateModal() {
    if (busy) {
      return;
    }

    resetForm();
  }

  /* ---------------------------------------------------------------------- */
  /* Open edit                                                              */
  /* ---------------------------------------------------------------------- */

  function openEditModal(
    recipient,
  ) {
    if (busy) {
      return;
    }

    setEditingId(
      recipient.id,
    );

    setName(
      recipient.name ||
        "",
    );

    setEmail(
      recipient.email ||
        "",
    );

    setRole(
      recipient.role ||
        "CUSTOMER_SERVICE",
    );

    setEnabled(
      Boolean(
        recipient.enabled,
      ),
    );

    setClientErrors({});
  }

  /* ---------------------------------------------------------------------- */
  /* Clear validation                                                       */
  /* ---------------------------------------------------------------------- */

  function clearFieldError(
    field,
  ) {
    /*
     * null intentionally overrides an
     * old server validation error.
     */
    setClientErrors(
      (current) => ({
        ...current,

        [field]:
          null,
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  function getErrors() {
    const relevantServerError =
      actionData?.success ===
        false &&
      (
        actionData?.intent ===
          "create" ||
        actionData?.intent ===
          "update"
      )
        ? (
            actionData.fieldErrors ??
            {}
          )
        : {};

    return {
      ...relevantServerError,
      ...clientErrors,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Save                                                                   */
  /* ---------------------------------------------------------------------- */

  function saveRecipient() {
    if (busy) {
      return;
    }

    const errors =
      validateRecipient({
        name,
        role,
        email,
      });

    if (
      Object.keys(
        errors,
      ).length > 0
    ) {
      setClientErrors(
        errors,
      );

      return;
    }

    setClientErrors({});

    const formData =
      new FormData();

    formData.set(
      "intent",
      editingId
        ? "update"
        : "create",
    );

    if (editingId) {
      formData.set(
        "id",
        editingId,
      );
    }

    formData.set(
      "name",
      name.trim(),
    );

    formData.set(
      "email",
      email
        .trim()
        .toLowerCase(),
    );

    formData.set(
      "role",
      role,
    );

    formData.set(
      "enabled",
      String(enabled),
    );

    submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Enable / disable                                                       */
  /* ---------------------------------------------------------------------- */

  function toggleRecipient(
    recipient,
  ) {
    if (busy) {
      return;
    }

    const formData =
      new FormData();

    formData.set(
      "intent",
      "toggle",
    );

    formData.set(
      "id",
      recipient.id,
    );

    submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Request delete                                                         */
  /* ---------------------------------------------------------------------- */

  function requestDelete(
    recipient,
  ) {
    if (
      busy ||
      !recipient?.id
    ) {
      return;
    }

    setDeleteTarget({
      ...recipient,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Confirm delete                                                         */
  /* ---------------------------------------------------------------------- */

  function confirmDelete() {
    if (
      busy ||
      !deleteTarget?.id
    ) {
      return;
    }

    const formData =
      new FormData();

    formData.set(
      "intent",
      "delete",
    );

    formData.set(
      "id",
      deleteTarget.id,
    );

    submit(
      formData,
      {
        method:
          "post",
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Loader error                                                           */
  /* ---------------------------------------------------------------------- */

  if (
    loaderData?.loaderError
  ) {
    return (
      <s-page
        heading="Notification Recipients"
        inlineSize="large"
      >
        <s-banner
          tone="critical"
          heading="Unable to load recipients"
        >
          <s-paragraph>
            {
              loaderData.loaderError
            }
          </s-paragraph>
        </s-banner>
      </s-page>
    );
  }

  const errors =
    getErrors();

  return (
    <s-page
      heading="Notification Recipients"
      inlineSize="large"
    >
      {/* ================================================================ */}
      {/* Primary action                                                   */}
      {/* ================================================================ */}

      <s-button
        slot="primary-action"
        variant="primary"
        disabled={busy}
        commandFor="recipient-editor-modal"
        command="--show"
        onClick={
          openCreateModal
        }
      >
        Add recipient
      </s-button>

      <s-stack
        direction="block"
        gap="base"
      >
        {/* ================================================================ */}
        {/* Description                                                      */}
        {/* ================================================================ */}

        <s-banner
          tone="info"
          heading="Internal Hyve notifications"
        >
          <s-paragraph>
            These recipients
            receive internal SLA,
            On Hold, artwork,
            production and
            delivery alerts.
            Customer order-status
            emails are sent to the
            email address on the
            Shopify order and do
            not use this list.
          </s-paragraph>
        </s-banner>

        {/* ================================================================ */}
        {/* Action error                                                     */}
        {/* ================================================================ */}

        {actionData
          ?.success ===
          false &&
          actionData
            ?.formError && (
            <s-banner
              tone="critical"
              heading={
                actionData
                  ?.intent ===
                "delete"
                  ? "Unable to delete recipient"
                  : "Unable to save recipient"
              }
            >
              <s-paragraph>
                {
                  actionData
                    .formError
                }
              </s-paragraph>
            </s-banner>
          )}

        {/* ================================================================ */}
        {/* Recipient list                                                   */}
        {/* ================================================================ */}

        <s-section>
          <s-stack
            direction="block"
            gap="base"
          >
            <s-heading>
              Recipients (
              {
                recipients.length
              }
              )
            </s-heading>

            {recipients.length ===
            0 ? (
              <s-box
                padding="large"
                border="base"
                borderRadius="base"
              >
                <s-stack
                  direction="block"
                  gap="base"
                  alignItems="center"
                >
                  <s-heading>
                    No notification
                    recipients
                  </s-heading>

                  <s-paragraph>
                    Add internal
                    recipients before
                    enabling automated
                    SLA alerts.
                  </s-paragraph>

                  <s-button
                    variant="primary"
                    disabled={busy}
                    commandFor="recipient-editor-modal"
                    command="--show"
                    onClick={
                      openCreateModal
                    }
                  >
                    Add recipient
                  </s-button>
                </s-stack>
              </s-box>
            ) : (
              <s-box
                border="base"
                borderRadius="base"
                padding="none"
              >
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Name
                    </s-table-header>

                    <s-table-header listSlot="labeled">
                      Email
                    </s-table-header>

                    <s-table-header listSlot="labeled">
                      Role
                    </s-table-header>

                    <s-table-header listSlot="labeled">
                      Status
                    </s-table-header>

                    <s-table-header listSlot="labeled">
                    </s-table-header>
                  </s-table-header-row>

                  <s-table-body>
                    {recipients.map(
                      (
                        recipient,
                      ) => (
                        <s-table-row
                          key={
                            recipient.id
                          }
                        >
                          <s-table-cell>
                            {
                              recipient.name
                            }
                          </s-table-cell>

                          <s-table-cell>
                            {
                              recipient.email
                            }
                          </s-table-cell>

                          <s-table-cell>
                            <s-badge
                              tone={roleTone(
                                recipient.role,
                              )}
                            >
                              {getRoleLabel(
                                recipient.role,
                              )}
                            </s-badge>
                          </s-table-cell>

                          <s-table-cell>
                            <s-badge
                              tone={
                                recipient.enabled
                                  ? "success"
                                  : "neutral"
                              }
                            >
                              {recipient.enabled
                                ? "Enabled"
                                : "Disabled"}
                            </s-badge>
                          </s-table-cell>

                          <s-table-cell>
                            <s-stack
                              direction="inline"
                              gap="small"
                            >
                              <s-button
                                variant="tertiary"
                                disabled={
                                  busy
                                }
                                commandFor="recipient-editor-modal"
                                command="--show"
                                onClick={() =>
                                  openEditModal(
                                    recipient,
                                  )
                                }
                              >
                                Edit
                              </s-button>

                              <s-button
                                variant="tertiary"
                                disabled={
                                  busy
                                }
                                onClick={() =>
                                  toggleRecipient(
                                    recipient,
                                  )
                                }
                              >
                                {recipient.enabled
                                  ? "Disable"
                                  : "Enable"}
                              </s-button>
                            </s-stack>
                          </s-table-cell>
                        </s-table-row>
                      ),
                    )}
                  </s-table-body>
                </s-table>
              </s-box>
            )}
          </s-stack>
        </s-section>


      </s-stack>

      <s-modal
        id="recipient-editor-modal"
        heading={
          isEditing
            ? "Edit notification recipient"
            : "Add notification recipient"
        }
        size="large"
      >
        <RecipientEditor
          name={name}
          email={email}
          role={role}
          enabled={enabled}
          errors={errors}
          busy={
            busy &&
            (
              submittingIntent ===
                "create" ||
              submittingIntent ===
                "update"
            )
          }
          isEditing={
            isEditing
          }
          onNameChange={(
            value,
          ) => {
            setName(value);
            clearFieldError(
              "name",
            );
          }}
          onEmailChange={(
            value,
          ) => {
            setEmail(value);
            clearFieldError(
              "email",
            );
          }}
          onRoleChange={(
            value,
          ) => {
            setRole(value);
            clearFieldError(
              "role",
            );
          }}
          onEnabledChange={
            setEnabled
          }
          onSave={
            saveRecipient
          }
          onDelete={() => {
            const recipient =
              recipients.find(
                (item) =>
                  item.id ===
                  editingId,
              );

            if (recipient) {
              requestDelete(
                recipient,
              );
            }
          }}
        />

        <s-button
          slot="secondary-actions"
          disabled={busy}
          commandFor="recipient-editor-modal"
          command="--hide"
          onClick={
            resetForm
          }
        >
          Cancel
        </s-button>
      </s-modal>

      {/* ================================================================ */}
      {/* Delete confirmation modal                                        */}
      {/* ================================================================ */}

      <s-modal
        id="recipient-delete-modal"
        heading="Delete notification recipient?"
      >
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Are you sure you
            want to delete this
            notification
            recipient?
          </s-paragraph>

          {deleteTarget && (
            <s-box
              padding="base"
              border="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="small"
              >
                <s-heading>
                  {
                    deleteTarget.name
                  }
                </s-heading>

                <s-text tone="neutral">
                  {
                    deleteTarget.email
                  }
                </s-text>

                <s-text tone="neutral">
                  Role:{" "}
                  {getRoleLabel(
                    deleteTarget.role,
                  )}
                </s-text>
              </s-stack>
            </s-box>
          )}

          <s-banner
            tone="warning"
            heading="This action cannot be undone"
          >
            <s-paragraph>
              The recipient will
              no longer receive
              Hyve internal
              notifications.
            </s-paragraph>
          </s-banner>
        </s-stack>

        <s-button
          slot="secondary-actions"
          disabled={deleting}
          commandFor="recipient-delete-modal"
          command="--hide"
          onClick={() =>
            setDeleteTarget(
              null,
            )
          }
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          tone="critical"
          variant="primary"
          disabled={
            deleting ||
            !deleteTarget
          }
          onClick={
            confirmDelete
          }
        >
          {deleting
            ? "Deleting..."
            : "Delete recipient"}
        </s-button>
      </s-modal>
    </s-page>
  );
}

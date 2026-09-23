/**
 * Metaobject service for Distributor Applications.
 * Manages metaobject definition, creation, queries, and status updates.
 */

export const METAOBJECT_TYPE = "$app:distributor_application";
export const FALLBACK_METAOBJECT_TYPE = "distributor_application";
export const METAOBJECT_TYPES = [METAOBJECT_TYPE, FALLBACK_METAOBJECT_TYPE];

export const METAOBJECT_FIELDS_SCHEMA = [
  { name: "Company Name", key: "company_name", type: "single_line_text_field" },
  { name: "Company Website", key: "company_website", type: "single_line_text_field" },
  { name: "Contact Person", key: "contact_person", type: "single_line_text_field" },
  { name: "Contact Phone", key: "contact_phone", type: "single_line_text_field" },
  { name: "Customer ID", key: "customer_id", type: "single_line_text_field" },
  { name: "Company ID", key: "company_id", type: "single_line_text_field" },
  { name: "Customer Email", key: "customer_email", type: "single_line_text_field" },
  { name: "Business Type", key: "business_type", type: "single_line_text_field" },
  { name: "Relation to Business", key: "relation_to_business", type: "single_line_text_field" },
  { name: "Preferred Currency", key: "preferred_currency", type: "single_line_text_field" },
  { name: "Country Based In", key: "country_based", type: "single_line_text_field" },
  { name: "Markets Sold Into", key: "markets_sold", type: "single_line_text_field" },
  { name: "Request Credit", key: "request_credit", type: "single_line_text_field" },
  { name: "Registration Number", key: "registration_number", type: "single_line_text_field" },
  { name: "Tax Registration Number", key: "tax_registration_number", type: "single_line_text_field" },
  { name: "Expected Annual Volume", key: "expected_annual_volume", type: "single_line_text_field" },
  { name: "Registered Address", key: "registered_address", type: "multi_line_text_field" },
  { name: "Status", key: "status", type: "single_line_text_field" },
  { name: "Submitted At", key: "submitted_at", type: "single_line_text_field" },
  { name: "Registration Document Name", key: "registration_document_name", type: "single_line_text_field" },
  { name: "Registration Document URL", key: "registration_document_url", type: "multi_line_text_field" },
  { name: "Rejection Message", key: "rejection_message", type: "multi_line_text_field" },
];

/**
 * Ensure that the distributor_application metaobject definition exists.
 * Safe to call idempotently.
 */
export async function ensureDistributorMetaobjectDefinition(admin) {
  if (!admin) return { ok: false, error: "No admin client." };

  // Already there? Nothing to do. Checks both the app-owned type and the plain
  // one, since either is usable once it exists.
  for (const type of METAOBJECT_TYPES) {
    const found = await definitionByType(admin, type);
    if (found) {
      await addMissingFields(admin, found);
      // The definition's own type, not the candidate we searched by, so the
      // caller creates against exactly what exists.
      return { ok: true, type: found.type || type };
    }
  }

  // Create the app-owned type: it belongs to this app, so it can't collide with
  // anything the merchant has defined.
  const type = METAOBJECT_TYPE;
  try {
    const response = await admin.graphql(
      `#graphql
      mutation EnsureDistributorMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) {
          metaobjectDefinition { id type }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          definition: {
            name: "Distributor Application",
            type,
            access: { admin: "MERCHANT_READ_WRITE" },
            fieldDefinitions: METAOBJECT_FIELDS_SCHEMA,
          },
        },
      },
    );

    const body = await response.json();
    const result = body?.data?.metaobjectDefinitionCreate;
    const error = result?.userErrors?.[0];

    if (error) {
      // TAKEN means another process created it between our check and now.
      if (error.code === "TAKEN") return { ok: true, type };
      console.warn("[metaobject] definition create failed:", JSON.stringify(result.userErrors));
      return { ok: false, error: `${error.message}${error.field ? ` (${error.field})` : ""}` };
    }

    if (body?.errors) {
      console.warn("[metaobject] definition create errors:", JSON.stringify(body.errors));
      return { ok: false, error: body.errors[0]?.message || "Could not create the definition." };
    }

    return { ok: true, type: result?.metaobjectDefinition?.type || type };
  } catch (err) {
    console.warn("[metaobject] definition create threw:", err?.message || err);
    return { ok: false, error: err?.message || "Could not create the definition." };
  }
}

/** Returns the definition for a type, or null when it doesn't exist. */
async function definitionByType(admin, type) {
  try {
    const response = await admin.graphql(
      `#graphql
      query DistributorDefinition($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
          type
          fieldDefinitions { key }
        }
      }`,
      { variables: { type } },
    );
    const body = await response.json();
    return body?.data?.metaobjectDefinitionByType || null;
  } catch {
    return null;
  }
}

/**
 * Adds any field this app expects that the existing definition doesn't have.
 *
 * A definition created by an earlier version is missing the fields added since,
 * and a metaobject can't carry a field its definition doesn't declare — so the
 * value would be dropped without complaint. Shopify won't change a field's type
 * once it exists, so this only ever adds.
 */
async function addMissingFields(admin, definition) {
  const existing = new Set((definition.fieldDefinitions || []).map((f) => f.key));
  const missing = METAOBJECT_FIELDS_SCHEMA.filter((f) => !existing.has(f.key));
  if (!missing.length) return;

  console.log(
    `[metaobject] adding missing fields to ${definition.type}:`,
    missing.map((f) => f.key).join(", "),
  );

  try {
    const response = await admin.graphql(
      `#graphql
      mutation AddMissingMetaobjectFields($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
        metaobjectDefinitionUpdate(id: $id, definition: $definition) {
          metaobjectDefinition { id }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          id: definition.id,
          definition: {
            fieldDefinitions: missing.map((f) => ({
              create: { name: f.name, key: f.key, type: f.type },
            })),
          },
        },
      },
    );
    const body = await response.json();
    const error = body?.data?.metaobjectDefinitionUpdate?.userErrors?.[0];
    if (error) console.warn("[metaobject] could not add fields:", error.message);
  } catch (err) {
    console.warn("[metaobject] add fields threw:", err?.message || err);
  }
}

/**
 * Fetch a customer's submitted application (if any).
 */
export async function getCustomerApplication(admin, customerId) {
  if (!admin || !customerId) return null;

  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;
  const rawId = customerId.replace("gid://shopify/Customer/", "");

  for (const type of METAOBJECT_TYPES) {
    try {
      const response = await admin.graphql(
        `#graphql
        query GetDistributorApplications($type: String!) {
          metaobjects(type: $type, first: 100, reverse: true) {
            nodes {
              id
              handle
              updatedAt
              fields {
                key
                value
              }
            }
          }
        }`,
        { variables: { type } },
      );

      const body = await response.json();
      const nodes = body?.data?.metaobjects?.nodes || [];

      for (const node of nodes) {
        const fieldMap = Object.fromEntries(node.fields.map((f) => [f.key, f.value]));
        if (
          fieldMap.customer_id === gid ||
          fieldMap.customer_id === rawId ||
          fieldMap.customer_id?.includes(rawId)
        ) {
          return {
            id: node.id,
            handle: node.handle,
            updatedAt: node.updatedAt,
            ...fieldMap,
          };
        }
      }

      if (nodes.length > 0) {
        return null;
      }
    } catch (err) {
      console.warn(`[metaobject] getCustomerApplication (${type}) warning:`, err?.message || err);
    }
  }

  return null;
}

/**
 * Fetch all distributor applications (for admin app).
 */
export async function getAllDistributorApplications(admin) {
  if (!admin) return [];

  // Applications can sit under either type: the app-owned one this app creates,
  // and the plain one an earlier config declared. Returning as soon as one type
  // had rows hid everything in the other, so both are gathered and merged.
  const found = [];
  const seen = new Set();

  for (const type of METAOBJECT_TYPES) {
    try {
      const response = await admin.graphql(
        `#graphql
        query GetAllApplications($type: String!) {
          metaobjects(type: $type, first: 100, reverse: true) {
            nodes {
              id
              handle
              updatedAt
              fields {
                key
                value
              }
            }
          }
        }`,
        { variables: { type } },
      );

      const body = await response.json();
      const nodes = body?.data?.metaobjects?.nodes || [];

      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        const fieldMap = Object.fromEntries(node.fields.map((f) => [f.key, f.value]));
        found.push({
          id: node.id,
          handle: node.handle,
          updatedAt: node.updatedAt,
          type,
          ...fieldMap,
        });
      }
    } catch (err) {
      console.warn(`[metaobject] getAllDistributorApplications (${type}) warning:`, err?.message || err);
    }
  }

  console.log(
    `[metaobject] applications found: ${found.length}`,
    found.map((a) => `${a.type} ${a.id}`).join(", ") || "(none)",
  );
  return found;
}

/**
 * Fetch a single distributor application by GID, numeric ID, or handle.
 */
export async function getDistributorApplicationById(admin, idOrHandle) {
  if (!admin || !idOrHandle) return null;

  const target = String(idOrHandle).trim();
  const isGid = target.startsWith("gid://");
  const isNumeric = /^\d+$/.test(target);
  const gid = isGid ? target : isNumeric ? `gid://shopify/Metaobject/${target}` : null;

  if (gid) {
    try {
      const res = await admin.graphql(
        `#graphql
        query GetAppById($id: ID!) {
          metaobject(id: $id) {
            id
            handle
            updatedAt
            fields {
              key
              value
            }
          }
        }`,
        { variables: { id: gid } },
      );
      const data = await res.json();
      const node = data?.data?.metaobject;
      if (node?.id) {
        const fieldMap = Object.fromEntries((node.fields || []).map((f) => [f.key, f.value]));
        return {
          id: node.id,
          handle: node.handle,
          updatedAt: node.updatedAt,
          ...fieldMap,
        };
      }
    } catch (e) {
      console.warn("[metaobject] getDistributorApplicationById query error:", e);
    }
  }

  const all = await getAllDistributorApplications(admin);
  return (
    all.find(
      (a) =>
        a.id === target ||
        a.id?.replace("gid://shopify/Metaobject/", "") === target ||
        a.handle === target,
    ) || null
  );
}

/**
 * Create a new distributor application metaobject.
 */
export async function createDistributorApplication(admin, fields = {}) {
  // The definition has to exist before a metaobject of that type can be
  // created, so make sure it does. Idempotent — a definition that already
  // exists comes back as a userError we ignore.
  const definition = await ensureDistributorMetaobjectDefinition(admin);
  if (!definition.ok) {
    return { error: `Could not set up the application store: ${definition.error}` };
  }

  const cleanHandle = `app-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const metaobjectFields = [
    { key: "company_name", value: fields.companyName || "" },
    { key: "company_website", value: fields.companyWebsite || "" },
    { key: "contact_person", value: fields.contactPerson || "" },
    { key: "contact_phone", value: fields.contactPhone || "" },
    { key: "customer_id", value: fields.customerId || "" },
    { key: "company_id", value: fields.companyId || "" },
    { key: "customer_email", value: fields.customerEmail || "" },
    { key: "business_type", value: fields.businessType || "" },
    { key: "relation_to_business", value: fields.relationToBusiness || "" },
    { key: "preferred_currency", value: fields.preferredCurrency || "" },
    { key: "country_based", value: fields.countryBased || "Singapore" },
    { key: "markets_sold", value: fields.marketsSold || "Singapore" },
    { key: "request_credit", value: fields.requestCredit ? "true" : "false" },
    { key: "registration_number", value: fields.registrationNumber || "" },
    { key: "tax_registration_number", value: fields.taxRegistrationNumber || "" },
    { key: "expected_annual_volume", value: fields.expectedVolume || "" },
    { key: "registered_address", value: fields.registeredAddress || "" },
    { key: "registration_document_name", value: fields.registrationDocName || "" },
    { key: "registration_document_url", value: fields.registrationDocUrl || "" },
    { key: "rejection_message", value: fields.rejectionMessage || "" },
    { key: "status", value: "Pending Review" },
    {
      key: "submitted_at",
      value: new Date().toLocaleDateString("en-SG", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    },
  ];

  // Create against the type the definition actually has. Trying a list of
  // candidate types and reporting the last failure hid the real one: the plain
  // `distributor_application` is never defined on a store where this app owns
  // the definition, so every failure came back as "No metaobject definition
  // exists for type \"distributor_application\"" whatever had really gone wrong.
  const type = definition.type;

  try {
    const response = await admin.graphql(
      `#graphql
      mutation CreateDistributorApplication($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id handle type }
          userErrors { field message code }
        }
      }`,
      { variables: { metaobject: { type, handle: cleanHandle, fields: metaobjectFields } } },
    );

    const body = await response.json();

    if (body?.errors) {
      console.error(`[metaobject] create (${type}) failed:`, JSON.stringify(body.errors));
      return { error: body.errors[0]?.message || "Failed to save application" };
    }

    const errors = body?.data?.metaobjectCreate?.userErrors || [];
    if (errors.length) {
      console.error(`[metaobject] create (${type}) rejected:`, JSON.stringify(errors));
      return { error: errors.map((e) => `${e.message}${e.field ? ` (${e.field})` : ""}`).join(", ") };
    }

    const metaobject = body?.data?.metaobjectCreate?.metaobject;
    if (!metaobject?.id) return { error: "Failed to save application" };

    return { success: true, metaobject };
  } catch (err) {
    console.error(`[metaobject] create (${type}) threw:`, err?.message || err);
    return { error: err?.message || "Failed to save application" };
  }
}


/**
 * Update application status (Approve / Reject / Pending) in metaobject.
 */
export async function updateDistributorApplicationStatus(admin, id, newStatus) {
  return updateDistributorApplication(admin, id, { status: newStatus });
}

/**
 * Update any fields on a distributor application (e.g. status, customer_id, company_id, rejection_message).
 */
export async function updateDistributorApplication(
  admin,
  id,
  fieldsToUpdate = {},
) {
  console.log(
    "[metaobjectUpdate] Requested ID:",
    id,
    "Fields:",
    JSON.stringify(fieldsToUpdate),
  );

  try {
    if (!admin?.graphql) {
      return {
        success: false,
        error: "Shopify Admin GraphQL client is not available.",
      };
    }

    if (!id) {
      return {
        success: false,
        error: "Application ID is required.",
      };
    }

    if (
      !fieldsToUpdate ||
      typeof fieldsToUpdate !== "object" ||
      Array.isArray(fieldsToUpdate)
    ) {
      return {
        success: false,
        error: "fieldsToUpdate must be an object.",
      };
    }

    /**
     * Convert values to Shopify metaobject field values.
     *
     * Metaobject field values are strings.
     * Arrays/objects are JSON encoded instead of becoming
     * "[object Object]".
     */
    const normalizeValue = (value) => {
      if (value === undefined || value === null) {
        return null;
      }

      if (typeof value === "string") {
        return value;
      }

      if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
      ) {
        return String(value);
      }

      if (Array.isArray(value) || typeof value === "object") {
        try {
          return JSON.stringify(value);
        } catch (error) {
          console.warn(
            "[metaobjectUpdate] Could not JSON stringify value:",
            error,
          );

          return String(value);
        }
      }

      return String(value);
    };

    /**
     * Build Shopify metaobject fields.
     */
    const fields = Object.entries(fieldsToUpdate)
      .filter(([key, value]) => {
        return (
          key &&
          typeof key === "string" &&
          value !== undefined &&
          value !== null
        );
      })
      .map(([key, value]) => ({
        key: key.trim(),
        value: normalizeValue(value),
      }))
      .filter((field) => field.key && field.value !== null);

    if (fields.length === 0) {
      console.log("[metaobjectUpdate] No fields to update.");

      return {
        success: true,
        updatedFields: [],
      };
    }

    /**
     * Resolve the Metaobject GID.
     */
    const idStr = String(id).trim();

    let targetGid = null;

    if (idStr.startsWith("gid://shopify/Metaobject/")) {
      targetGid = idStr;
    } else if (/^\d+$/.test(idStr)) {
      targetGid = `gid://shopify/Metaobject/${idStr}`;
    } else {
      /**
       * If the supplied ID is not a GID or numeric ID,
       * try resolving it through the existing helper.
       */
      const existing = await getDistributorApplicationById(admin, idStr);

      if (existing?.id) {
        targetGid = String(existing.id).trim();
      }
    }

    if (!targetGid) {
      return {
        success: false,
        error: `Could not locate application record for ID: ${idStr}`,
      };
    }

    console.log("[metaobjectUpdate] Target GID:", targetGid);
    console.log("[metaobjectUpdate] Fields:", JSON.stringify(fields));

    /**
     * Execute the mutation.
     */
    const updateMetaobject = async (fieldsToSend) => {
      const response = await admin.graphql(
        `#graphql
          mutation UpdateMetaobject(
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
                type
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
            id: targetGid,
            metaobject: {
              fields: fieldsToSend,
            },
          },
        },
      );

      return response.json();
    };

    /**
     * Extract errors from Shopify response.
     */
    const getErrors = (body) => {
      const errors = [];

      // Top-level GraphQL errors
      if (Array.isArray(body?.errors)) {
        errors.push(...body.errors);
      }

      // Mutation-level userErrors
      if (Array.isArray(body?.data?.metaobjectUpdate?.userErrors)) {
        errors.push(...body.data.metaobjectUpdate.userErrors);
      }

      return errors;
    };

    /**
     * Extract unsupported field keys from Shopify errors.
     *
     * Handles errors such as:
     *
     * Field 'foo' does not exist
     *
     * and field paths such as:
     *
     * ["metaobject", "fields", 0, "key"]
     */
    const getInvalidFieldKeys = (errors, currentFields) => {
      const invalidKeys = new Set();

      for (const error of errors) {
        const message = String(error?.message || "");

        /**
         * Example:
         * Field 'some_field' does not exist
         */
        const messageMatches = [
          ...message.matchAll(
            /Field ['"]([^'"]+)['"] does not exist/gi,
          ),
        ];

        for (const match of messageMatches) {
          if (match?.[1]) {
            invalidKeys.add(match[1]);
          }
        }

        /**
         * Shopify can return a field path.
         *
         * Example:
         * ["metaobject", "fields", 2, "key"]
         */
        if (Array.isArray(error?.field)) {
          const fieldPath = error.field;

          const fieldsIndex = fieldPath.findIndex(
            (item) => item === "fields",
          );

          if (fieldsIndex !== -1) {
            const index = Number(fieldPath[fieldsIndex + 1]);

            if (
              Number.isInteger(index) &&
              index >= 0 &&
              index < currentFields.length
            ) {
              invalidKeys.add(currentFields[index].key);
            }
          }
        }

        /**
         * Sometimes Shopify puts the field key directly
         * in the message.
         */
        for (const field of currentFields) {
          if (
            message.includes(`'${field.key}'`) ||
            message.includes(`"${field.key}"`) ||
            message.includes(field.key)
          ) {
            if (
              /invalid|invalid field|does not exist|unknown field|unsupported/i.test(
                message,
              )
            ) {
              invalidKeys.add(field.key);
            }
          }
        }
      }

      return invalidKeys;
    };

    /**
     * First update attempt.
     */
    let body = await updateMetaobject(fields);

    console.log(
      "[metaobjectUpdate] Shopify response:",
      JSON.stringify(body),
    );

    let errors = getErrors(body);

    /**
     * SUCCESS
     */
    if (errors.length === 0) {
      const metaobject =
        body?.data?.metaobjectUpdate?.metaobject;

      if (!metaobject?.id) {
        return {
          success: false,
          error:
            "Shopify did not return the updated metaobject.",
        };
      }

      console.log(
        "[metaobjectUpdate] Update succeeded:",
        metaobject.id,
      );

      return {
        success: true,
        id: metaobject.id,
        handle: metaobject.handle,
        type: metaobject.type,
        updatedFields: fields.map((field) => field.key),
      };
    }

    /**
     * Try to identify unsupported fields.
     */
    const invalidKeys = getInvalidFieldKeys(errors, fields);

    if (invalidKeys.size > 0) {
      console.warn(
        "[metaobjectUpdate] Unsupported fields detected:",
        Array.from(invalidKeys),
      );

      const fallbackFields = fields.filter(
        (field) => !invalidKeys.has(field.key),
      );

      /**
       * If every field is invalid, don't send an empty mutation.
       */
      if (fallbackFields.length === 0) {
        return {
          success: false,
          error: errors
            .map((error) => error?.message)
            .filter(Boolean)
            .join(", "),
          invalidFields: Array.from(invalidKeys),
        };
      }

      console.log(
        "[metaobjectUpdate] Retrying without unsupported fields:",
        JSON.stringify(fallbackFields),
      );

      /**
       * Retry only with valid fields.
       */
      body = await updateMetaobject(fallbackFields);

      console.log(
        "[metaobjectUpdate] Retry response:",
        JSON.stringify(body),
      );

      errors = getErrors(body);

      if (errors.length === 0) {
        const metaobject =
          body?.data?.metaobjectUpdate?.metaobject;

        if (!metaobject?.id) {
          return {
            success: false,
            error:
              "Retry completed but Shopify did not return the updated metaobject.",
          };
        }

        console.log(
          "[metaobjectUpdate] Retry update succeeded:",
          metaobject.id,
        );

        return {
          success: true,
          id: metaobject.id,
          handle: metaobject.handle,
          type: metaobject.type,
          updatedFields: fallbackFields.map(
            (field) => field.key,
          ),
          skippedFields: Array.from(invalidKeys),
        };
      }
    }

    /**
     * Final failure.
     */
    const errorMessage =
      errors
        .map((error) => {
          const message = error?.message || "Unknown Shopify error";

          if (Array.isArray(error?.field)) {
            return `${message} (${error.field.join(".")})`;
          }

          return message;
        })
        .filter(Boolean)
        .join(", ") ||
      "Failed to update metaobject.";

    console.error(
      "[metaobjectUpdate] Shopify update failed:",
      errorMessage,
    );

    return {
      success: false,
      error: errorMessage,
    };
  } catch (error) {
    console.error(
      "[metaobjectUpdate] Exception:",
      error,
    );

    return {
      success: false,
      error:
        error?.message ||
        "Failed to update distributor application.",
    };
  }
}
/**
 * Permanently delete an application record.
 *
 * Accepts a full metaobject ID, a bare numeric ID, or a handle, because the
 * admin screens pass whichever they happen to hold.
 */
export async function deleteDistributorApplication(admin, idOrHandle) {
  if (!admin || !idOrHandle) {
    return { success: false, error: "Application ID is required." };
  }

  const target = String(idOrHandle).trim();
  let targetGid = target.startsWith("gid://")
    ? target
    : /^\d+$/.test(target)
      ? `gid://shopify/Metaobject/${target}`
      : null;

  if (!targetGid) {
    const existing = await getDistributorApplicationById(admin, target);
    targetGid = existing?.id ? String(existing.id).trim() : null;
  }

  if (!targetGid) {
    return { success: false, error: `Could not find an application for "${target}".` };
  }

  try {
    const response = await admin.graphql(
      `#graphql
      mutation DeleteMetaobject($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message code }
        }
      }`,
      { variables: { id: targetGid } },
    );

    const body = await response.json();
    if (body?.errors) {
      return { success: false, error: body.errors[0]?.message || "Delete failed." };
    }

    const userErrors = body?.data?.metaobjectDelete?.userErrors || [];
    if (userErrors.length) {
      const message = userErrors.map((e) => e.message).join(", ");
      console.warn("[metaobject] delete error:", message);
      return { success: false, error: message };
    }

    return { success: true, deletedId: body?.data?.metaobjectDelete?.deletedId || targetGid };
  } catch (err) {
    console.error("[metaobject] delete threw:", err?.message || err);
    return { success: false, error: err?.message || "Failed to delete the application." };
  }
}

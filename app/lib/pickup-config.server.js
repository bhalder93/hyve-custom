export const METAOBJECT_TYPE = "$app:pickup_configuration"; // using app-owned metaobject for reliable creation

export const METAOBJECT_FIELDS_SCHEMA = [
  { name: "Pickup Address", key: "pickup_address", type: "multi_line_text_field" },
  { name: "Contact Name", key: "contact_name", type: "single_line_text_field" },
  { name: "Contact Phone", key: "contact_phone", type: "single_line_text_field" },
  { name: "Contact Email", key: "contact_email", type: "single_line_text_field" },
  { name: "Monday Hours", key: "monday_hours", type: "single_line_text_field" },
  { name: "Tuesday Hours", key: "tuesday_hours", type: "single_line_text_field" },
  { name: "Wednesday Hours", key: "wednesday_hours", type: "single_line_text_field" },
  { name: "Thursday Hours", key: "thursday_hours", type: "single_line_text_field" },
  { name: "Friday Hours", key: "friday_hours", type: "single_line_text_field" },
  { name: "Saturday Hours", key: "saturday_hours", type: "single_line_text_field" },
  { name: "Sunday Hours", key: "sunday_hours", type: "single_line_text_field" },
];

export async function ensurePickupConfigDefinition(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
        query GetDefinition($type: String!) {
          metaobjectDefinitionByType(type: $type) {
            id
            type
            fieldDefinitions {
              key
            }
          }
        }
      `,
      { variables: { type: METAOBJECT_TYPE } }
    );
    const body = await response.json();
    const existingDef = body?.data?.metaobjectDefinitionByType;
    if (existingDef) {
      const existingKeys = new Set((existingDef.fieldDefinitions || []).map((f) => f.key));
      const missingFields = METAOBJECT_FIELDS_SCHEMA.filter((f) => !existingKeys.has(f.key));
      if (missingFields.length > 0) {
        try {
          await admin.graphql(
            `#graphql
              mutation UpdateDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
                metaobjectDefinitionUpdate(id: $id, definition: $definition) {
                  metaobjectDefinition { id }
                  userErrors { field message code }
                }
              }
            `,
            {
              variables: {
                id: existingDef.id,
                definition: {
                  fieldDefinitions: missingFields.map((f) => ({
                    create: { name: f.name, key: f.key, type: f.type },
                  })),
                },
              },
            }
          );
        } catch (updateErr) {
          console.warn("Could not update metaobject definition with missing fields:", updateErr);
        }
      }
      return { ok: true, type: existingDef.type };
    }
  } catch (error) {
    console.warn("Could not fetch definition:", error);
  }

  try {
    const response = await admin.graphql(
      `#graphql
        mutation CreateDefinition($definition: MetaobjectDefinitionCreateInput!) {
          metaobjectDefinitionCreate(definition: $definition) {
            metaobjectDefinition { id type }
            userErrors { field message code }
          }
        }
      `,
      {
        variables: {
          definition: {
            name: "Pickup Configuration",
            type: METAOBJECT_TYPE,
            access: { admin: "MERCHANT_READ_WRITE" },
            fieldDefinitions: METAOBJECT_FIELDS_SCHEMA,
          },
        },
      }
    );
    const body = await response.json();
    const result = body?.data?.metaobjectDefinitionCreate;
    const error = result?.userErrors?.[0];

    if (error && error.code !== "TAKEN") {
      return { ok: false, error: error.message };
    }
    return { ok: true, type: METAOBJECT_TYPE };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function loadPickupConfig(admin) {
  await ensurePickupConfigDefinition(admin);

  try {
    const response = await admin.graphql(
      `#graphql
        query GetPickupConfigs($type: String!) {
          metaobjects(type: $type, first: 1) {
            nodes {
              id
              handle
              fields { key value }
            }
          }
        }
      `,
      { variables: { type: METAOBJECT_TYPE } }
    );
    const body = await response.json();
    const node = body?.data?.metaobjects?.nodes?.[0];
    
    const values = {};
    for (const field of METAOBJECT_FIELDS_SCHEMA) {
      values[field.key] = "";
    }
    
    if (node) {
      for (const field of node.fields) {
        values[field.key] = field.value || "";
      }
      return { id: node.id, values };
    }
    return { id: null, values };
  } catch (error) {
    return { id: null, values: {}, error: error?.message || String(error) };
  }
}

export async function savePickupConfig(admin, values, metaobjectId) {
  const fields = METAOBJECT_FIELDS_SCHEMA.map(f => ({
    key: f.key,
    value: values[f.key] || ""
  }));

  if (metaobjectId) {
    const response = await admin.graphql(
      `#graphql
        mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          id: metaobjectId,
          metaobject: { fields }
        }
      }
    );
    const body = await response.json();
    const error = body?.data?.metaobjectUpdate?.userErrors?.[0];
    if (error) throw new Error(error.message);
    return { ok: true };
  } else {
    const response = await admin.graphql(
      `#graphql
        mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          metaobject: {
            type: METAOBJECT_TYPE,
            fields
          }
        }
      }
    );
    const body = await response.json();
    const error = body?.data?.metaobjectCreate?.userErrors?.[0];
    if (error) throw new Error(error.message);
    return { ok: true };
  }
}

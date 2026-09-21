/**
 * Moving an order along the J3 chain, and recording why.
 *
 * The chain lives in a `hyve-status:*` tag. Only one may be present, so a move
 * removes whatever is there before adding the new one — otherwise two tags sit
 * on the order and which one wins depends on tag ordering.
 *
 * Shared by every action that advances an order from the portal, so the tag
 * format and the note format stay in one place.
 */

const STATUS_TAG_PREFIX = "hyve-status:";

const TAGS_ADD = `#graphql
  mutation StatusTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

const TAGS_REMOVE = `#graphql
  mutation StatusTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

const ORDER_NOTE = `#graphql
  mutation StatusNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      userErrors { field message }
    }
  }`;

export async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");
  return body?.data || {};
}

/**
 * @param {string[]} currentTags the order's tags as they are now
 * @param {string} value the new status, without the prefix
 */
export async function setOrderStatusTag(admin, orderGid, currentTags, value) {
  const existing = (currentTags || []).filter((tag) =>
    String(tag).toLowerCase().startsWith(STATUS_TAG_PREFIX),
  );
  if (existing.length) {
    await gql(admin, TAGS_REMOVE, { id: orderGid, tags: existing });
  }
  await gql(admin, TAGS_ADD, { id: orderGid, tags: [`${STATUS_TAG_PREFIX}${value}`] });
}

/**
 * Append to the order's note rather than replacing it, so a back-and-forth
 * survives. ART-03 wants the person and the time against each decision.
 */
export async function appendOrderNote(admin, orderGid, existingNote, entry) {
  const stamped = `[${new Date().toISOString()}] ${entry}`;
  const note = [existingNote, stamped].filter(Boolean).join("\n\n");
  await gql(admin, ORDER_NOTE, { input: { id: orderGid, note } });
}

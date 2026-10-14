async function runTagMutation(admin, operation, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  const errors = [
    ...(body?.errors || []),
    ...(body?.data?.[operation]?.userErrors || []),
  ];

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).filter(Boolean).join(", "));
  }
}

/** Keep order status tags aligned when a customer decides on a physical sample. */
export async function syncSampleStatusTags(admin, orderGid, currentTags, nextStatus, extraTags = []) {
  const statusTags = [...new Set((currentTags || []).filter((tag) => tag.startsWith("hyve-status:")))];
  const tagsToAdd = [...new Set([`hyve-status:${nextStatus}`, ...extraTags])];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (statusTags.length) {
        await runTagMutation(
          admin,
          "tagsRemove",
          `#graphql mutation RemoveSampleStatusTags($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: orderGid, tags: statusTags },
        );
      }

      await runTagMutation(
        admin,
        "tagsAdd",
        `#graphql mutation AddSampleStatusTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { id: orderGid, tags: tagsToAdd },
      );
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      console.warn("[sample-approval] retrying sample status tag sync:", error?.message || error);
    }
  }
}

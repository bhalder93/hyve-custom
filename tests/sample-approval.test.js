import test from "node:test";
import assert from "node:assert/strict";
import { syncSampleStatusTags } from "../app/lib/sample-status-tags.server.js";

test("sample approval removes the review tag and adds production approval tags", async () => {
  const mutations = [];
  const admin = {
    async graphql(query, { variables }) {
      mutations.push({ query, variables });
      const operation = query.includes("tagsRemove") ? "tagsRemove" : "tagsAdd";
      return { json: async () => ({ data: { [operation]: { userErrors: [] } } }) };
    },
  };

  await syncSampleStatusTags(
    admin,
    "gid://shopify/Order/123",
    ["hyve-status:sample-review", "hyve-status:on-hold", "hyve-sample-approved"],
    "in-production",
    ["hyve-sample-approved"],
  );

  assert.deepEqual(mutations[0].variables.tags, [
    "hyve-status:sample-review",
    "hyve-status:on-hold",
  ]);
  assert.deepEqual(mutations[1].variables.tags, [
    "hyve-status:in-production",
    "hyve-sample-approved",
  ]);
});

test("sample tag sync retries and reports Shopify user errors", async () => {
  let attempts = 0;
  const admin = {
    async graphql() {
      attempts += 1;
      return {
        json: async () => ({
          data: { tagsRemove: { userErrors: [{ message: "Tag update rejected" }] } },
        }),
      };
    },
  };

  await assert.rejects(
    syncSampleStatusTags(
      admin,
      "gid://shopify/Order/123",
      ["hyve-status:sample-review"],
      "in-production",
      ["hyve-sample-approved"],
    ),
    /Tag update rejected/,
  );
  assert.equal(attempts, 2);
});

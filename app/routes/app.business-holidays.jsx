// app/routes/app.business-holidays.jsx

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";

import { authenticate } from "../shopify.server";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */

const METAOBJECT_TYPE =
  "$app:business_holiday";

const MARKET_OPTIONS = [
  {
    label: "China",
    value: "CN",
  },
  {
    label: "Singapore",
    value: "SG",
  },
  {
    label: "Hong Kong",
    value: "HK",
  },
  {
    label: "Malaysia",
    value: "MY",
  },
  {
    label: "Philippines",
    value: "PH",
  },
  {
    label: "Taiwan",
    value: "TW",
  },
  {
    label: "Thailand",
    value: "TH",
  },
  {
    label: "Indonesia",
    value: "ID",
  },
];

/* -------------------------------------------------------------------------- */
/*                              GraphQL helpers                               */
/* -------------------------------------------------------------------------- */

async function parseGraphQLResponse(
  response,
  operationName,
) {
  const data =
    await response.json();

  if (data.errors?.length) {
    console.error(
      `${operationName} GraphQL errors:`,
      data.errors,
    );

    throw new Error(
      data.errors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }

  return data;
}

function throwUserErrors(
  errors,
  operationName,
) {
  if (!errors?.length) {
    return;
  }

  console.error(
    `${operationName} user errors:`,
    errors,
  );

  throw new Error(
    errors
      .map(
        (error) =>
          error.message,
      )
      .join(", "),
  );
}

/* -------------------------------------------------------------------------- */
/*                              Get holidays                                  */
/* -------------------------------------------------------------------------- */

async function getBusinessHolidays(
  admin,
) {
  const response =
    await admin.graphql(
      `#graphql
        query GetBusinessHolidays {
          metaobjects(
            type: "$app:business_holiday"
            first: 250
          ) {
            nodes {
              id
              handle

              name: field(
                key: "name"
              ) {
                value
              }

              market: field(
                key: "market"
              ) {
                value
              }

              date: field(
                key: "date"
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

  const data =
    await parseGraphQLResponse(
      response,
      "GetBusinessHolidays",
    );

  return (
    data.data?.metaobjects
      ?.nodes ?? []
  )
    .map((node) => ({
      id:
        node.id,

      handle:
        node.handle || "",

      name:
        node.name?.value ||
        "",

      market:
        node.market?.value ||
        "",

      date:
        node.date?.value ||
        "",

      enabled:
        node.enabled?.value !==
        "false",
    }))
    .sort((a, b) => {
      if (
        a.date ===
        b.date
      ) {
        return a.name.localeCompare(
          b.name,
        );
      }

      return a.date.localeCompare(
        b.date,
      );
    });
}

/* -------------------------------------------------------------------------- */
/*                           Save / update holiday                            */
/* -------------------------------------------------------------------------- */

async function upsertBusinessHoliday(
  admin,
  holiday,
) {
  const response =
    await admin.graphql(
      `#graphql
        mutation SaveBusinessHoliday(
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
            type:
              METAOBJECT_TYPE,

            handle:
              holiday.handle,
          },

          metaobject: {
            fields: [
              {
                key:
                  "name",

                value:
                  holiday.name,
              },
              {
                key:
                  "market",

                value:
                  holiday.market,
              },
              {
                key:
                  "date",

                value:
                  holiday.date,
              },
              {
                key:
                  "enabled",

                value:
                  String(
                    Boolean(
                      holiday.enabled,
                    ),
                  ),
              },
            ],
          },
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "SaveBusinessHoliday",
    );

  throwUserErrors(
    data.data
      ?.metaobjectUpsert
      ?.userErrors,
    "SaveBusinessHoliday",
  );

  return (
    data.data
      ?.metaobjectUpsert
      ?.metaobject ||
    null
  );
}

/* -------------------------------------------------------------------------- */
/*                              Delete holiday                                */
/* -------------------------------------------------------------------------- */

async function deleteBusinessHoliday(
  admin,
  id,
) {
  const response =
    await admin.graphql(
      `#graphql
        mutation DeleteBusinessHoliday(
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

  const data =
    await parseGraphQLResponse(
      response,
      "DeleteBusinessHoliday",
    );

  throwUserErrors(
    data.data
      ?.metaobjectDelete
      ?.userErrors,
    "DeleteBusinessHoliday",
  );

  return (
    data.data
      ?.metaobjectDelete
      ?.deletedId ||
    null
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function createHolidayHandle(
  market,
  date,
  name,
) {
  const namePart =
    String(name)
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-+|-+$/g,
        "",
      );

  return `${market.toLowerCase()}-${date}-${namePart}`.slice(
    0,
    240,
  );
}

function validateHoliday(
  holiday,
) {
  const errors = {};

  if (
    !holiday.name?.trim()
  ) {
    errors.name =
      "Holiday name is required.";
  }

  if (
    !holiday.market?.trim()
  ) {
    errors.market =
      "Production market is required.";
  }

  if (
    !holiday.date?.trim()
  ) {
    errors.date =
      "Holiday date is required.";
  } else {
    const datePattern =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      !datePattern.test(
        holiday.date,
      )
    ) {
      errors.date =
        "Enter a valid date.";
    } else {
      const parsed =
        new Date(
          `${holiday.date}T00:00:00Z`,
        );

      if (
        Number.isNaN(
          parsed.getTime(),
        )
      ) {
        errors.date =
          "Enter a valid date.";
      }
    }
  }

  return errors;
}

function getMarketLabel(
  value,
) {
  return (
    MARKET_OPTIONS.find(
      (market) =>
        market.value ===
        value,
    )?.label ||
    value ||
    "-"
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Loader                                   */
/* -------------------------------------------------------------------------- */

export async function loader({
  request,
}) {
  const {
    admin,
  } =
    await authenticate.admin(
      request,
    );

  try {
    const holidays =
      await getBusinessHolidays(
        admin,
      );

    return {
      holidays,

      loaderError:
        null,
    };
  } catch (error) {
    console.error(
      "Business holidays loader error:",
      error,
    );

    return {
      holidays: [],

      loaderError:
        error instanceof Error
          ? error.message
          : "Unable to load business holidays.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Action                                   */
/* -------------------------------------------------------------------------- */

export async function action({
  request,
}) {
  const {
    admin,
  } =
    await authenticate.admin(
      request,
    );

  try {
    const formData =
      await request.formData();

    const intent =
      String(
        formData.get(
          "intent",
        ) || "",
      ).trim();

    /* ====================================================================== */
    /* Save                                                                   */
    /* ====================================================================== */

    if (
      intent === "save"
    ) {
      const id =
        String(
          formData.get(
            "id",
          ) || "",
        ).trim();

      const tempId =
        String(
          formData.get(
            "tempId",
          ) || "",
        ).trim();

      let handle =
        String(
          formData.get(
            "handle",
          ) || "",
        ).trim();

      const holiday = {
        id,

        handle,

        name:
          String(
            formData.get(
              "name",
            ) || "",
          ).trim(),

        market:
          String(
            formData.get(
              "market",
            ) || "",
          ).trim(),

        date:
          String(
            formData.get(
              "date",
            ) || "",
          ).trim(),

        enabled:
          String(
            formData.get(
              "enabled",
            ) || "",
          ) === "true",
      };

      const fieldErrors =
        validateHoliday(
          holiday,
        );

      if (
        Object.keys(
          fieldErrors,
        ).length > 0
      ) {
        return {
          success: false,

          intent,

          tempId,

          handle,

          fieldErrors,

          formError:
            "Please correct the highlighted fields.",
        };
      }

      if (!handle) {
        handle =
          createHolidayHandle(
            holiday.market,
            holiday.date,
            holiday.name,
          );
      }

      await upsertBusinessHoliday(
        admin,
        {
          ...holiday,

          handle,
        },
      );

      return {
        success: true,

        intent,

        tempId,

        message:
          id
            ? "Business holiday updated successfully."
            : "Business holiday created successfully.",

        fieldErrors: {},

        formError:
          null,
      };
    }

    /* ====================================================================== */
    /* Delete                                                                 */
    /* ====================================================================== */

    if (
      intent ===
      "delete"
    ) {
      const id =
        String(
          formData.get(
            "id",
          ) || "",
        ).trim();

      const tempId =
        String(
          formData.get(
            "tempId",
          ) || "",
        ).trim();

      if (!id) {
        return {
          success: false,

          intent,

          tempId,

          fieldErrors: {},

          formError:
            "Holiday ID is required.",
        };
      }

      await deleteBusinessHoliday(
        admin,
        id,
      );

      return {
        success: true,

        intent,

        tempId,

        message:
          "Business holiday deleted successfully.",

        fieldErrors: {},

        formError:
          null,
      };
    }

    return {
      success: false,

      intent,

      fieldErrors: {},

      formError:
        "Unsupported action.",
    };
  } catch (error) {
    console.error(
      "Business holidays action error:",
      error,
    );

    return {
      success: false,

      fieldErrors: {},

      formError:
        error instanceof Error
          ? error.message
          : "Something went wrong.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Holiday editor                                */
/* -------------------------------------------------------------------------- */

function HolidayEditor({
  holiday,
  errors,
  busy,
  onChange,
  onSave,
  onDelete,
}) {
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
          label="Holiday name"
          value={
            holiday.name ||
            ""
          }
          error={
            errors?.name ||
            undefined
          }
          onInput={(
            event,
          ) =>
            onChange(
              holiday.tempId,
              "name",
              event
                .currentTarget
                .value,
            )
          }
        />

        <s-select
          label="Production market"
          value={
            holiday.market ||
            ""
          }
          error={
            errors?.market ||
            undefined
          }
          onChange={(
            event,
          ) =>
            onChange(
              holiday.tempId,
              "market",
              event
                .currentTarget
                .value,
            )
          }
        >
          <s-option value="">
            Select market
          </s-option>

          {MARKET_OPTIONS.map(
            (market) => (
              <s-option
                key={
                  market.value
                }
                value={
                  market.value
                }
              >
                {
                  market.label
                }
              </s-option>
            ),
          )}
        </s-select>

        <s-date-field
          label="Holiday date"
          value={
            holiday.date ||
            ""
          }
          error={
            errors?.date ||
            undefined
          }
          onChange={(
            event,
          ) =>
            onChange(
              holiday.tempId,
              "date",
              event
                .currentTarget
                .value,
            )
          }
        />
      </s-grid>

      <s-checkbox
        label="Enabled"
        checked={Boolean(
          holiday.enabled,
        )}
        onChange={(
          event,
        ) =>
          onChange(
            holiday.tempId,
            "enabled",
            event
              .currentTarget
              .checked,
          )
        }
      />

      {holiday.handle && (
        <s-text tone="neutral">
          Metaobject handle:{" "}
          {
            holiday.handle
          }
        </s-text>
      )}

      <s-divider />

      <s-stack
        direction="inline"
        justifyContent="space-between"
        gap="base"
      >
        <div>
          {!holiday.isNew && (
            <s-button
              tone="critical"
              disabled={busy}
              commandFor="holiday-delete-modal"
              command="--show"
              onClick={() =>
                onDelete(
                  holiday,
                )
              }
            >
              Delete
            </s-button>
          )}
        </div>

        <s-button
          variant="primary"
          disabled={busy}
          onClick={() =>
            onSave(
              holiday,
            )
          }
        >
          {busy
            ? "Saving..."
            : holiday.isNew
              ? "Add holiday"
              : "Save changes"}
        </s-button>
      </s-stack>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/*                                    Page                                    */
/* -------------------------------------------------------------------------- */

export default function BusinessHolidaysPage() {
  const loaderData =
    useLoaderData();

  const actionData =
    useActionData();

  const submit =
    useSubmit();

  const navigation =
    useNavigation();

  const editorModalRef =
    useRef(null);

  const deleteModalRef =
    useRef(null);

  const [
    items,
    setItems,
  ] =
    useState([]);

  const [
    editingHoliday,
    setEditingHoliday,
  ] =
    useState(null);

  const [
    deleteTarget,
    setDeleteTarget,
  ] =
    useState(null);

  const [
    clientErrors,
    setClientErrors,
  ] =
    useState({});

  /* ---------------------------------------------------------------------- */
  /* Sync loader data                                                       */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    setItems(
      (
        loaderData?.holidays ??
        []
      ).map(
        (holiday) => ({
          ...holiday,

          tempId:
            holiday.id,

          isNew:
            false,
        }),
      ),
    );
  }, [
    loaderData?.holidays,
  ]);

  const busy =
    navigation.state !==
    "idle";

  const submittingTempId =
    useMemo(() => {
      if (
        navigation.state ===
        "idle"
      ) {
        return null;
      }

      return (
        navigation.formData?.get(
          "tempId",
        ) ?? null
      );
    }, [
      navigation,
    ]);

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
        ) ?? null
      );
    }, [
      navigation,
    ]);

  const editorBusy =
    busy &&
    editingHoliday &&
    submittingTempId ===
      editingHoliday.tempId;

  const deleting =
    busy &&
    submittingIntent ===
      "delete" &&
    deleteTarget &&
    submittingTempId ===
      deleteTarget.tempId;

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
      "save"
    ) {
      editorModalRef
        .current
        ?.hideOverlay?.();

      setEditingHoliday(
        null,
      );

      setClientErrors(
        {},
      );
    }

    if (
      actionData.intent ===
      "delete"
    ) {
      deleteModalRef
        .current
        ?.hideOverlay?.();

      editorModalRef
        .current
        ?.hideOverlay?.();

      setDeleteTarget(
        null,
      );

      setEditingHoliday(
        null,
      );

      setClientErrors(
        {},
      );
    }
  }, [
    actionData,
  ]);

  /* ---------------------------------------------------------------------- */
  /* Add holiday                                                            */
  /* ---------------------------------------------------------------------- */

  function addHoliday() {
    if (busy) {
      return;
    }

    const tempId =
      `new-${Date.now()}`;

    setEditingHoliday({
      id:
        "",

      handle:
        "",

      tempId,

      isNew:
        true,

      name:
        "",

      market:
        "",

      date:
        "",

      enabled:
        true,
    });

    setClientErrors(
      {},
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Edit holiday                                                           */
  /* ---------------------------------------------------------------------- */

  function editHoliday(
    holiday,
  ) {
    if (busy) {
      return;
    }

    setEditingHoliday({
      ...holiday,
    });

    setClientErrors(
      {},
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Update field                                                           */
  /* ---------------------------------------------------------------------- */

  function updateHoliday(
    tempId,
    key,
    value,
  ) {
    setEditingHoliday(
      (current) => {
        if (
          !current ||
          current.tempId !==
            tempId
        ) {
          return current;
        }

        return {
          ...current,

          [key]:
            value,
        };
      },
    );

    /*
     * Local errors are merged after server errors.
     * Setting the corrected field to null overrides
     * an old server-side validation message.
     */
    setClientErrors(
      (current) => ({
        ...current,

        [tempId]: {
          ...(
            current[
              tempId
            ] || {}
          ),

          [key]:
            null,
        },
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Save holiday                                                           */
  /* ---------------------------------------------------------------------- */

  function saveHoliday(
    holiday,
  ) {
    if (
      busy ||
      !holiday
    ) {
      return;
    }

    const errors =
      validateHoliday(
        holiday,
      );

    if (
      Object.keys(
        errors,
      ).length > 0
    ) {
      setClientErrors(
        (current) => ({
          ...current,

          [holiday.tempId]:
            errors,
        }),
      );

      return;
    }

    setClientErrors(
      (current) => ({
        ...current,

        [holiday.tempId]:
          {},
      }),
    );

    const formData =
      new FormData();

    formData.set(
      "intent",
      "save",
    );

    formData.set(
      "tempId",
      holiday.tempId,
    );

    formData.set(
      "id",
      holiday.id ||
        "",
    );

    formData.set(
      "handle",
      holiday.handle ||
        "",
    );

    formData.set(
      "name",
      holiday.name,
    );

    formData.set(
      "market",
      holiday.market,
    );

    formData.set(
      "date",
      holiday.date,
    );

    formData.set(
      "enabled",
      String(
        Boolean(
          holiday.enabled,
        ),
      ),
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

  function requestDeleteHoliday(
    holiday,
  ) {
    if (
      busy ||
      !holiday?.id
    ) {
      return;
    }

    setDeleteTarget({
      ...holiday,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Confirm delete                                                         */
  /* ---------------------------------------------------------------------- */

  function confirmDeleteHoliday() {
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

    formData.set(
      "tempId",
      deleteTarget.tempId,
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
  /* Cancel delete                                                          */
  /* ---------------------------------------------------------------------- */

  function cancelDelete() {
    if (deleting) {
      return;
    }

    setDeleteTarget(
      null,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Cancel editor                                                          */
  /* ---------------------------------------------------------------------- */

  function cancelEditor() {
    if (editorBusy) {
      return;
    }

    setEditingHoliday(
      null,
    );

    setClientErrors(
      {},
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  function getErrors(
    holiday,
  ) {
    if (!holiday) {
      return {};
    }

    const local =
      clientErrors[
        holiday.tempId
      ] ?? {};

    const server =
      actionData?.success ===
        false &&
      actionData?.intent ===
        "save" &&
      actionData?.tempId ===
        holiday.tempId
        ? (
            actionData.fieldErrors ??
            {}
          )
        : {};

    return {
      ...server,
      ...local,
    };
  }

  return (
    <s-page
      heading="Business Holidays"
      inlineSize="large"
    >
      {/* ================================================================ */}
      {/* Primary action                                                   */}
      {/* ================================================================ */}

      <s-button
        slot="primary-action"
        variant="primary"
        disabled={busy}
        commandFor="holiday-editor-modal"
        command="--show"
        onClick={
          addHoliday
        }
      >
        Add holiday
      </s-button>

      {/* ================================================================ */}
      {/* Loader error                                                     */}
      {/* ================================================================ */}

      {loaderData
        ?.loaderError && (
        <s-banner
          tone="critical"
          heading="Unable to load holidays"
        >
          <s-paragraph>
            {
              loaderData
                .loaderError
            }
          </s-paragraph>
        </s-banner>
      )}

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
                ? "Unable to delete holiday"
                : "Unable to save holiday"
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
      {/* Holiday list                                                     */}
      {/* ================================================================ */}

      <s-section>
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Configure holidays
            that should be
            excluded when
            calculating
            business-day
            production
            deadlines.
          </s-paragraph>

          {items.length ===
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
                  No business holidays
                </s-heading>

                <s-paragraph>
                  Add holidays
                  for production
                  markets before
                  business-day SLA
                  calculations are
                  enabled.
                </s-paragraph>

                <s-button
                  variant="primary"
                  disabled={busy}
                  commandFor="holiday-editor-modal"
                  command="--show"
                  onClick={
                    addHoliday
                  }
                >
                  Add holiday
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
                    Market
                  </s-table-header>

                  <s-table-header listSlot="labeled">
                    Date
                  </s-table-header>

                  <s-table-header listSlot="labeled">
                    Status
                  </s-table-header>

                  <s-table-header listSlot="labeled">
                  </s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {items.map(
                    (holiday) => (
                      <s-table-row
                        key={
                          holiday.id
                        }
                      >
                        <s-table-cell>
                          {
                            holiday.name ||
                            "(Untitled)"
                          }
                        </s-table-cell>

                        <s-table-cell>
                          {getMarketLabel(
                            holiday.market,
                          )}
                        </s-table-cell>

                        <s-table-cell>
                          {
                            holiday.date ||
                            "-"
                          }
                        </s-table-cell>

                        <s-table-cell>
                          {holiday.enabled ? (
                            <s-badge tone="success">
                              Enabled
                            </s-badge>
                          ) : (
                            <s-badge tone="critical">
                              Disabled
                            </s-badge>
                          )}
                        </s-table-cell>

                        <s-table-cell>
                          <s-button
                            variant="tertiary"
                            disabled={
                              busy
                            }
                            commandFor="holiday-editor-modal"
                            command="--show"
                            onClick={() =>
                              editHoliday(
                                holiday,
                              )
                            }
                          >
                            Edit
                          </s-button>
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

      {/* ================================================================ */}
      {/* Add / Edit modal                                                 */}
      {/* ================================================================ */}

      <s-modal
        ref={
          editorModalRef
        }
        id="holiday-editor-modal"
        heading={
          editingHoliday
            ?.isNew
            ? "Add business holiday"
            : editingHoliday
                ?.name
              ? `Edit ${editingHoliday.name}`
              : "Edit business holiday"
        }
        size="large"
      >
        {editingHoliday ? (
          <HolidayEditor
            holiday={
              editingHoliday
            }
            errors={
              getErrors(
                editingHoliday,
              )
            }
            busy={Boolean(
              editorBusy,
            )}
            onChange={
              updateHoliday
            }
            onSave={
              saveHoliday
            }
            onDelete={
              requestDeleteHoliday
            }
          />
        ) : (
          <s-paragraph>
            Select a holiday
            to edit.
          </s-paragraph>
        )}

        <s-button
          slot="secondary-actions"
          disabled={
            editorBusy
          }
          commandFor="holiday-editor-modal"
          command="--hide"
          onClick={
            cancelEditor
          }
        >
          Cancel
        </s-button>
      </s-modal>

      {/* ================================================================ */}
      {/* Delete confirmation modal                                        */}
      {/* ================================================================ */}

      <s-modal
        ref={
          deleteModalRef
        }
        id="holiday-delete-modal"
        heading="Delete business holiday?"
      >
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Are you sure you
            want to delete this
            business holiday?
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
                  Market:{" "}
                  {getMarketLabel(
                    deleteTarget.market,
                  )}
                </s-text>

                <s-text tone="neutral">
                  Date:{" "}
                  {
                    deleteTarget.date
                  }
                </s-text>

                <s-text tone="neutral">
                  Status:{" "}
                  {deleteTarget.enabled
                    ? "Enabled"
                    : "Disabled"}
                </s-text>
              </s-stack>
            </s-box>
          )}

          <s-banner
            tone="warning"
            heading="This action cannot be undone"
          >
            <s-paragraph>
              The holiday will
              be permanently
              removed from the
              business holiday
              configuration.
            </s-paragraph>
          </s-banner>
        </s-stack>

        <s-button
          slot="secondary-actions"
          disabled={
            deleting
          }
          commandFor="holiday-delete-modal"
          command="--hide"
          onClick={
            cancelDelete
          }
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={
            deleting ||
            !deleteTarget
          }
          onClick={
            confirmDeleteHoliday
          }
        >
          {deleting
            ? "Deleting..."
            : "Delete holiday"}
        </s-button>
      </s-modal>
    </s-page>
  );
}
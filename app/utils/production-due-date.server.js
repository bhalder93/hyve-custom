// app/utils/production-due-date.server.js

const BUSINESS_HOLIDAY_TYPE =
  "$app:business_holiday";

const DEFAULT_STANDARD_DAYS = 7;
const DEFAULT_RUSH_DAYS = 4;

const DEFAULT_PRODUCTION_MARKET =
  "CN";

/* -------------------------------------------------------------------------- */
/*                              GraphQL helper                                */
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

/* -------------------------------------------------------------------------- */
/*                               Date helpers                                 */
/* -------------------------------------------------------------------------- */

function pad(value) {
  return String(value).padStart(
    2,
    "0",
  );
}

function getSingaporeDateParts(
  value,
) {
  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    throw new Error(
      "Invalid production approval date.",
    );
  }

  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Singapore",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23",
      },
    );

  const parts =
    formatter.formatToParts(
      date,
    );

  const values = {};

  for (
    const part of parts
  ) {
    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] = part.value;
    }
  }

  return {
    year:
      Number(
        values.year,
      ),

    month:
      Number(
        values.month,
      ),

    day:
      Number(
        values.day,
      ),

    hour:
      Number(
        values.hour,
      ),

    minute:
      Number(
        values.minute,
      ),

    second:
      Number(
        values.second,
      ),
  };
}

function dateKey(
  year,
  month,
  day,
) {
  return `${year}-${pad(
    month,
  )}-${pad(day)}`;
}

/**
 * Use a UTC date only as a safe calendar container.
 *
 * We are counting business calendar days.
 * Time-of-day is preserved separately.
 */
function createCalendarDate(
  year,
  month,
  day,
) {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      0,
      0,
      0,
      0,
    ),
  );
}

function getCalendarKey(
  date,
) {
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function isWeekend(
  date,
) {
  const day =
    date.getUTCDay();

  return (
    day === 0 ||
    day === 6
  );
}

/**
 * Singapore is UTC+8 throughout the year.
 *
 * Converts a Singapore local date/time back
 * to a UTC ISO timestamp.
 */
function singaporeLocalToUtc({
  year,
  month,
  day,
  hour,
  minute,
  second,
}) {
  const utcMillis =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      0,
    ) -
    8 *
      60 *
      60 *
      1000;

  return new Date(
    utcMillis,
  );
}

/* -------------------------------------------------------------------------- */
/*                         Business holiday query                             */
/* -------------------------------------------------------------------------- */

export async function getBusinessHolidays(
  admin,
  market = DEFAULT_PRODUCTION_MARKET,
) {
  if (!admin) {
    throw new Error(
      "Shopify Admin client is required.",
    );
  }

  const response =
    await admin.graphql(
      `#graphql
        query ProductionBusinessHolidays {
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
      "ProductionBusinessHolidays",
    );

  return (
    data.data
      ?.metaobjects
      ?.nodes ||
    []
  )
    .filter(
      (holiday) => {
        const enabled =
          holiday.enabled
            ?.value !==
          "false";

        const itemMarket =
          holiday.market
            ?.value ||
          "";

        const holidayDate =
          holiday.date
            ?.value ||
          "";

        return (
          enabled &&
          itemMarket ===
            market &&
          Boolean(
            holidayDate,
          )
        );
      },
    )
    .map(
      (holiday) => ({
        id:
          holiday.id,

        handle:
          holiday.handle,

        name:
          holiday.name
            ?.value ||
          "",

        market:
          holiday.market
            ?.value ||
          "",

        date:
          holiday.date
            ?.value ||
          "",
      }),
    );
}

/* -------------------------------------------------------------------------- */
/*                     Calculate business-day deadline                       */
/* -------------------------------------------------------------------------- */

export async function calculateProductionDueDate({
  admin,
  approvedAt,
  rush = false,
  market = DEFAULT_PRODUCTION_MARKET,
  standardDays = DEFAULT_STANDARD_DAYS,
  rushDays = DEFAULT_RUSH_DAYS,
}) {
  if (!approvedAt) {
    throw new Error(
      "Proof approval timestamp is required.",
    );
  }

  const businessDays =
    rush
      ? rushDays
      : standardDays;

  if (
    !Number.isInteger(
      businessDays,
    ) ||
    businessDays <= 0
  ) {
    throw new Error(
      "Production business days must be a positive integer.",
    );
  }

  const approvalParts =
    getSingaporeDateParts(
      approvedAt,
    );

  const holidays =
    await getBusinessHolidays(
      admin,
      market,
    );

  const holidayDates =
    new Set(
      holidays.map(
        (holiday) =>
          holiday.date,
      ),
    );

  let current =
    createCalendarDate(
      approvalParts.year,
      approvalParts.month,
      approvalParts.day,
    );

  let countedDays = 0;

  const skipped = [];

  /**
   * Approval day is Day 0.
   *
   * We begin counting from the following
   * calendar day.
   */
  while (
    countedDays <
    businessDays
  ) {
    current.setUTCDate(
      current.getUTCDate() +
        1,
    );

    const key =
      getCalendarKey(
        current,
      );

    if (
      isWeekend(
        current,
      )
    ) {
      skipped.push({
        date:
          key,

        reason:
          "weekend",
      });

      continue;
    }

    if (
      holidayDates.has(
        key,
      )
    ) {
      const holiday =
        holidays.find(
          (item) =>
            item.date ===
            key,
        );

      skipped.push({
        date:
          key,

        reason:
          "holiday",

        name:
          holiday?.name ||
          "",
      });

      continue;
    }

    countedDays += 1;
  }

  /**
   * Preserve proof approval time-of-day.
   */
  const dueDate =
    singaporeLocalToUtc({
      year:
        current.getUTCFullYear(),

      month:
        current.getUTCMonth() +
        1,

      day:
        current.getUTCDate(),

      hour:
        approvalParts.hour,

      minute:
        approvalParts.minute,

      second:
        approvalParts.second,
    });

  return {
    dueAt:
      dueDate.toISOString(),

    market,

    rush:
      Boolean(rush),

    businessDays,

    skipped,

    holidays,
  };
}

/* -------------------------------------------------------------------------- */
/*                       Save production_due_at                               */
/* -------------------------------------------------------------------------- */

export async function saveProductionDueDate({
  admin,
  orderId,
  dueAt,
}) {
  if (!orderId) {
    throw new Error(
      "Order ID is required.",
    );
  }

  if (!dueAt) {
    throw new Error(
      "Production due date is required.",
    );
  }

  const response =
    await admin.graphql(
      `#graphql
        mutation SaveProductionDueDate(
          $metafields: [MetafieldsSetInput!]!
        ) {
          metafieldsSet(
            metafields: $metafields
          ) {
            metafields {
              id
              namespace
              key
              value
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
          metafields: [
            {
              ownerId:
                orderId,

              namespace:
                "$app",

              key:
                "production_due_at",

              type:
                "date_time",

              value:
                dueAt,
            },
          ],
        },
      },
    );

  const data =
    await parseGraphQLResponse(
      response,
      "SaveProductionDueDate",
    );

  const userErrors =
    data.data
      ?.metafieldsSet
      ?.userErrors ||
    [];

  if (
    userErrors.length
  ) {
    throw new Error(
      userErrors
        .map(
          (error) =>
            error.message,
        )
        .join(", "),
    );
  }

  return (
    data.data
      ?.metafieldsSet
      ?.metafields ||
    []
  );
}

/* -------------------------------------------------------------------------- */
/*                    Calculate + save in one function                       */
/* -------------------------------------------------------------------------- */

export async function calculateAndSaveProductionDueDate({
  admin,
  orderId,
  approvedAt,
  rush = false,
  market = DEFAULT_PRODUCTION_MARKET,
  standardDays = DEFAULT_STANDARD_DAYS,
  rushDays = DEFAULT_RUSH_DAYS,
}) {
  const result =
    await calculateProductionDueDate({
      admin,

      approvedAt,

      rush,

      market,

      standardDays,

      rushDays,
    });

  await saveProductionDueDate({
    admin,

    orderId,

    dueAt:
      result.dueAt,
  });

  return result;
}
// app/utils/production-due-date.server.js

const BUSINESS_HOLIDAY_TYPE = "$app:business_holiday";

const DEFAULT_STANDARD_DAYS = 7;
const DEFAULT_RUSH_DAYS = 4;

/**
 * Hyve production market.
 *
 * IMPORTANT:
 * Your Holidays page uses production-market holidays.
 * If your production market is Singapore, keep this as SG.
 */
const DEFAULT_PRODUCTION_MARKET = "SG";

/* -------------------------------------------------------------------------- */
/*                              GraphQL helper                                */
/* -------------------------------------------------------------------------- */

async function parseGraphQLResponse(response, operationName) {
  const data = await response.json();

  if (data.errors?.length) {
    console.error(`${operationName} GraphQL errors:`, data.errors);

    throw new Error(data.errors.map((error) => error.message).join(", "));
  }

  return data;
}

/* -------------------------------------------------------------------------- */
/*                               Date helpers                                 */
/* -------------------------------------------------------------------------- */

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeMarket(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeHolidayDate(value) {
  if (!value) {
    return "";
  }

  /**
   * Holiday metaobject should normally store YYYY-MM-DD.
   *
   * This also safely handles:
   * 2026-10-01T00:00:00Z
   */
  return String(value).trim().slice(0, 10);
}

function getSingaporeDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid production approval date.");
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",

    year: "numeric",

    month: "2-digit",

    day: "2-digit",

    hour: "2-digit",

    minute: "2-digit",

    second: "2-digit",

    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),

    month: Number(values.month),

    day: Number(values.day),

    hour: Number(values.hour),

    minute: Number(values.minute),

    second: Number(values.second),
  };
}

function dateKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Use a UTC date only as a safe calendar container.
 *
 * We are counting business calendar days.
 * Time-of-day is preserved separately.
 */
function createCalendarDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function getCalendarKey(date) {
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function isWeekend(date) {
  const day = date.getUTCDay();

  return day === 0 || day === 6;
}

/**
 * Singapore is UTC+8 throughout the year.
 *
 * Converts a Singapore local date/time back
 * to a UTC ISO timestamp.
 */
function singaporeLocalToUtc({ year, month, day, hour, minute, second }) {
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second, 0) -
    8 * 60 * 60 * 1000;

  return new Date(utcMillis);
}

/* -------------------------------------------------------------------------- */
/*                         Business holiday query                             */
/* -------------------------------------------------------------------------- */

export async function getBusinessHolidays(
  admin,
  market = DEFAULT_PRODUCTION_MARKET,
) {
  if (!admin) {
    throw new Error("Shopify Admin client is required.");
  }

  const normalizedMarket = normalizeMarket(market);

  const response = await admin.graphql(
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

  const data = await parseGraphQLResponse(
    response,
    "ProductionBusinessHolidays",
  );

  const allHolidays = data.data?.metaobjects?.nodes || [];

  /**
   * Debug:
   * Shows exactly what Shopify returned.
   */
  console.log("[PRODUCTION HOLIDAYS] Loaded", {
    requestedMarket: normalizedMarket,

    total: allHolidays.length,

    holidays: allHolidays.map((holiday) => ({
      name: holiday.name?.value || "",

      market: holiday.market?.value || "",

      normalizedMarket: normalizeMarket(holiday.market?.value),

      date: holiday.date?.value || "",

      enabled: holiday.enabled?.value !== "false",
    })),
  });

  const matchingHolidays = allHolidays
    .filter((holiday) => {
      const enabled = holiday.enabled?.value !== "false";

      const itemMarket = normalizeMarket(holiday.market?.value);

      const holidayDate = normalizeHolidayDate(holiday.date?.value);

      return enabled && itemMarket === normalizedMarket && Boolean(holidayDate);
    })
    .map((holiday) => ({
      id: holiday.id,

      handle: holiday.handle,

      name: holiday.name?.value || "",

      market: normalizeMarket(holiday.market?.value),

      date: normalizeHolidayDate(holiday.date?.value),
    }));

  console.log("[PRODUCTION HOLIDAYS] Matching", {
    market: normalizedMarket,

    count: matchingHolidays.length,

    holidays: matchingHolidays,
  });

  return matchingHolidays;
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
  console.log("market",market)
  if (!approvedAt) {
    throw new Error("Proof approval timestamp is required.");
  }

  const normalizedMarket = normalizeMarket(market || DEFAULT_PRODUCTION_MARKET);

  const businessDays = rush ? rushDays : standardDays;

  if (!Number.isInteger(businessDays) || businessDays <= 0) {
    throw new Error("Production business days must be a positive integer.");
  }

  const approvalParts = getSingaporeDateParts(approvedAt);

  console.log("[PRODUCTION DUE DATE] Start", {
    approvedAt,

    approvalSingapore: approvalParts,

    rush: Boolean(rush),

    businessDays,

    market: normalizedMarket,
  });

  const holidays = await getBusinessHolidays(admin, normalizedMarket);

  const holidayDates = new Set(
    holidays.map((holiday) => normalizeHolidayDate(holiday.date)),
  );

  let current = createCalendarDate(
    approvalParts.year,
    approvalParts.month,
    approvalParts.day,
  );

  let countedDays = 0;

  const skipped = [];

  /**
   * Approval day = Day 0.
   *
   * Counting starts from the following calendar day.
   */
  while (countedDays < businessDays) {
    current.setUTCDate(current.getUTCDate() + 1);

    const key = getCalendarKey(current);

    /**
     * Weekend
     */
    if (isWeekend(current)) {
      skipped.push({
        date: key,

        reason: "weekend",
      });

      console.log("[PRODUCTION DUE DATE] Skip weekend", key);

      continue;
    }

    /**
     * Production-market holiday
     */
    if (holidayDates.has(key)) {
      const holiday = holidays.find(
        (item) => normalizeHolidayDate(item.date) === key,
      );

      skipped.push({
        date: key,

        reason: "holiday",

        name: holiday?.name || "",
      });

      console.log("[PRODUCTION DUE DATE] Skip holiday", {
        date: key,

        name: holiday?.name || "",

        market: normalizedMarket,
      });

      continue;
    }

    countedDays += 1;

    console.log("[PRODUCTION DUE DATE] Count business day", {
      date: key,

      day: countedDays,

      total: businessDays,
    });
  }

  /**
   * Preserve proof approval time-of-day.
   */
  const dueDate = singaporeLocalToUtc({
    year: current.getUTCFullYear(),

    month: current.getUTCMonth() + 1,

    day: current.getUTCDate(),

    hour: approvalParts.hour,

    minute: approvalParts.minute,

    second: approvalParts.second,
  });

  const result = {
    dueAt: dueDate.toISOString(),

    market: normalizedMarket,

    rush: Boolean(rush),

    businessDays,

    skipped,

    holidays,
  };

  console.log("[PRODUCTION DUE DATE] Result", result);

  return result;
}

/* -------------------------------------------------------------------------- */
/*                       Save production_due_at                               */
/* -------------------------------------------------------------------------- */

export async function saveProductionDueDate({ admin, orderId, dueAt }) {
  if (!admin) {
    throw new Error("Shopify Admin client is required.");
  }

  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  if (!dueAt) {
    throw new Error("Production due date is required.");
  }

  const dueDate = new Date(dueAt);

  if (Number.isNaN(dueDate.getTime())) {
    throw new Error("Production due date is invalid.");
  }

  const normalizedDueAt = dueDate.toISOString();

  const response = await admin.graphql(
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
            ownerId: orderId,

            namespace: "$app",

            key: "production_due_at",

            type: "date_time",

            value: normalizedDueAt,
          },
        ],
      },
    },
  );

  const data = await parseGraphQLResponse(response, "SaveProductionDueDate");

  const userErrors = data.data?.metafieldsSet?.userErrors || [];

  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join(", "));
  }

  console.log("[PRODUCTION DUE DATE] Saved", {
    orderId,
    dueAt: normalizedDueAt,
  });

  return data.data?.metafieldsSet?.metafields || [];
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
  const normalizedMarket = normalizeMarket(market || DEFAULT_PRODUCTION_MARKET);

  console.log("[PRODUCTION DUE DATE] Calculate and save", {
    orderId,
    approvedAt,
    rush: Boolean(rush),
    market: normalizedMarket,
    standardDays,
    rushDays,
  });

  const result = await calculateProductionDueDate({
    admin,

    approvedAt,

    rush,

    market: normalizedMarket,

    standardDays,

    rushDays,
  });

  await saveProductionDueDate({
    admin,

    orderId,

    dueAt: result.dueAt,
  });

  return result;
}

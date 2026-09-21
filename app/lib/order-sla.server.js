export async function scheduleOrderSlaJob({
  shop,
  orderId,
  type,
  status,
  dueAt,
  data = {},
}) {
  console.log("[SLA:SCHEDULE]", {
    shop,
    orderId,
    type,
    status,
    dueAt,
    data,
  });

  return {
    ok: true,
    dummy: true,
  };
}

export async function cancelOrderSlaJobs({
  shop,
  orderId,
  status,
}) {
  console.log("[SLA:CANCEL]", {
    shop,
    orderId,
    status,
  });

  return {
    ok: true,
    dummy: true,
  };
}
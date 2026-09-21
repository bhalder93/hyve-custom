import {
  escapeHtml,
} from "../email-utils.server";

function internalTemplate({
  title,
  order,
  status,
  target,
  owner,
  orderAdminUrl,
  extra = "",
}) {
  const customer =
    order?.customer
      ?.displayName ||
    "Unknown customer";

  const html = `
    <h2>${escapeHtml(title)}</h2>

    <p>
      <strong>Order:</strong>
      ${escapeHtml(
        order?.name || "",
      )}
    </p>

    <p>
      <strong>Customer:</strong>
      ${escapeHtml(customer)}
    </p>

    <p>
      <strong>Status:</strong>
      ${escapeHtml(status)}
    </p>

    ${
      target
        ? `
          <p>
            <strong>Target:</strong>
            ${escapeHtml(target)}
          </p>
        `
        : ""
    }

    ${
      owner
        ? `
          <p>
            <strong>Assigned owner:</strong>
            ${escapeHtml(owner)}
          </p>
        `
        : ""
    }

    ${extra}

    ${
      orderAdminUrl
        ? `
          <p>
            <a href="${escapeHtml(
              orderAdminUrl,
            )}">
              Open order in Shopify Admin
            </a>
          </p>
        `
        : ""
    }
  `;

  const text = [
    title,
    `Order: ${order?.name || ""}`,
    `Customer: ${customer}`,
    `Status: ${status}`,
    target
      ? `Target: ${target}`
      : null,
    owner
      ? `Owner: ${owner}`
      : null,
    orderAdminUrl
      ? `Order: ${orderAdminUrl}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    html,
    text,
  };
}

export function msg10ArtworkMissing(
  args,
) {
  return {
    subject:
      `SLA Alert: Artwork not received – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Artwork not received within 24 hours",
      status:
        "Order Placed",
      target:
        "24 hours",
      owner:
        "Customer Service",
    }),
  };
}

export function msg11ProofNotSent(
  args,
) {
  return {
    subject:
      `SLA Alert: Proof not sent – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Proof not sent within 48 hours",
      status:
        "Artwork Received",
      target:
        "48 hours",
      owner:
        "Artwork / Customer Service",
    }),
  };
}

export function msg12ProofNotApproved(
  args,
) {
  return {
    subject:
      `SLA Alert: Proof not approved – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Proof not approved by day 10",
      status:
        "Proof Sent",
      target:
        "Day 10",
      owner:
        "Customer Service",
    }),
  };
}

export function msg13NotInProduction(
  args,
) {
  return {
    subject:
      `SLA Alert: Not in production – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Order not marked In Production",
      status:
        "Proof Approved",
      target:
        "24 hours",
      owner:
        "Production",
    }),
  };
}

export function msg14ProductionOverdue(
  args,
) {
  return {
    subject:
      `SLA Alert: Production overdue – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Production target missed",
      status:
        "In Production",
      target:
        args.target ||
        "Production due date",
      owner:
        "Production",
    }),
  };
}

export function msg15NotShipped(
  args,
) {
  return {
    subject:
      `SLA Alert: Not shipped – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Order not shipped within 48 hours",
      status:
        "Production Complete",
      target:
        "48 hours",
      owner:
        "Production",
    }),
  };
}

export function msg16NoDeliveryScan(
  args,
) {
  return {
    subject:
      `SLA Alert: No delivery scan – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "No delivery scan recorded",
      status:
        "Shipped",
      target:
        "48 hours",
      owner:
        "Customer Service / Production",
    }),
  };
}

export function msg17OrderOnHold(
  args,
) {
  return {
    subject:
      `Order on hold – ${args.order.name}`,

    ...internalTemplate({
      ...args,
      title:
        "Order placed on hold",
      status:
        "On Hold",
      owner:
        "Customer Service",

      extra:
        args.reason
          ? `
            <p>
              <strong>Reason:</strong>
              ${escapeHtml(
                args.reason,
              )}
            </p>
          `
          : "",
    }),
  };
}
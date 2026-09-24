/**
 * Promotions on the distributor dashboard (HYV-96, H3).
 *
 * Hyve staff publish them without a developer, under Content > Metaobjects >
 * Promotion: artwork, copy, an optional button, and the dates it runs. The
 * entry type is declared in shopify.app.toml. Shopify's Draft/Active switch
 * decides whether an entry is published; the dates decide when an active one
 * shows. Current promotions come first, then upcoming ones with their start
 * date, so distributors can plan ahead.
 */
const QUERY = `#graphql
  query DashboardPromotions {
    metaobjects(type: "$app:promotion", first: 50) {
      nodes {
        id
        capabilities { publishable { status } }
        title: field(key: "title") { value }
        copy: field(key: "copy") { value }
        link: field(key: "link") { value }
        linkLabel: field(key: "link_label") { value }
        startsOn: field(key: "starts_on") { value }
        endsOn: field(key: "ends_on") { value }
        artwork: field(key: "artwork") {
          reference { ... on MediaImage { image { url(transform: { maxWidth: 1200 }) altText } } }
        }
      }
    }
  }`;

/** How many the dashboard shows. */
const LIMIT = 6;

/** Promotion dates are Hyve's calendar days. */
const TIME_ZONE = "Asia/Singapore";

/**
 * @returns {Promise<Array<{id:string, title:string, copy:string, link:string, linkLabel:string,
 *   imageUrl:string, imageAlt:string, startsOn:string, endsOn:string, upcoming:boolean}>>}
 */
export async function loadPromotions(admin, now = new Date()) {
  const response = await admin.graphql(QUERY);
  const body = await response.json();
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || "Shopify rejected the request.");

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);

  return (body.data?.metaobjects?.nodes || [])
    .filter((node) => node.capabilities?.publishable?.status === "ACTIVE")
    .map((node) => ({
      id: node.id,
      title: node.title?.value || "",
      copy: node.copy?.value || "",
      link: node.link?.value || "",
      linkLabel: node.linkLabel?.value || "",
      imageUrl: node.artwork?.reference?.image?.url || "",
      imageAlt: node.artwork?.reference?.image?.altText || "",
      startsOn: node.startsOn?.value || "",
      endsOn: node.endsOn?.value || "",
    }))
    .filter((promo) => promo.title && promo.imageUrl && promo.startsOn)
    .filter((promo) => !promo.endsOn || promo.endsOn >= today)
    .map((promo) => ({ ...promo, upcoming: promo.startsOn > today }))
    // Current ones newest first, then upcoming ones soonest first.
    .sort((a, b) =>
      a.upcoming !== b.upcoming
        ? Number(a.upcoming) - Number(b.upcoming)
        : a.upcoming
          ? a.startsOn.localeCompare(b.startsOn)
          : b.startsOn.localeCompare(a.startsOn),
    )
    .slice(0, LIMIT);
}

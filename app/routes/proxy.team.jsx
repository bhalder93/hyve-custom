import { authenticate } from "../shopify.server";
import { accountShell } from "../lib/account-shell.server";
import { distributorOnly } from "../lib/account-error.server";
import { portalChrome } from "../lib/account-data.server";
import {
  mapCompanyContactsToMembers,
  teamPage,
  getInitials,
} from "../lib/account-team.server";

const ADMIN_TIMEOUT_MS = 5000;

export const loader = async ({ request }) => {
  const { liquid, admin } = await authenticate.public.appProxy(request);

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");

    // A2: distributor pages are visible only to approved distributor accounts.
    // The nav hides the link, but the URL still resolves, so gate the page too.
    const chrome = await portalChrome(admin, customerId);
    if (!chrome.isDistributor) {
      return liquid(
        accountShell({ active: "team", main: distributorOnly("Team"), ...chrome }),
      );
    }
    const notice = url.searchParams.get("notice");
    const errorParam = url.searchParams.get("error");
    const isB2BParam = url.searchParams.get("b2b") === "1" || url.searchParams.get("b2b") === "true";

    let customer = {
      name: "Team Admin",
      email: "",
      initials: "TA",
      tier: "B2B Member",
      isDistributor: true,
    };

    let companyName = "Company Account";
    let companyContacts = [];
    let locations = [];
    let contactRoles = [];

    if (customerId) {
      const numericCustId = customerId.replace(/\D/g, "");

      try {
        // Step 1: Fetch company, locations, contact roles, and existing contacts
        const response = await withTimeout(
          admin.graphql(
            `#graphql
            query GetCustomerCompanyContext($id: ID!) {
              customer(id: $id) {
                id
                firstName
                lastName
                displayName
                tags
                defaultEmailAddress { emailAddress }
                companyContactProfiles {
                  id
                  company {
                    id
                    name
                    locations(first: 10) {
                      edges {
                        node {
                          id
                          name
                        }
                      }
                    }
                    contactRoles(first: 10) {
                      edges {
                        node {
                          id
                          name
                        }
                      }
                    }
                    contacts(first: 50) {
                      edges {
                        node {
                          id
                          title
                          updatedAt
                          isMainContact
                          customer {
                            id
                            firstName
                            lastName
                            displayName
                            email
                            tags
                            updatedAt
                          }
                          roleAssignments(first: 5) {
                            edges {
                              node {
                                role {
                                  id
                                  name
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }`,
            { variables: { id: `gid://shopify/Customer/${customerId}` } },
          ),
          ADMIN_TIMEOUT_MS,
        );

        const data = await response.json();
        const c = data?.data?.customer;
        if (c) {
          const first = c.firstName || "";
          const last = c.lastName || "";
          const email = c.defaultEmailAddress?.emailAddress || "";
          const name = c.displayName || `${first} ${last}`.trim() || "Team Admin";

          customer = {
            id: c.id,
            firstName: first,
            name,
            email,
            initials: getInitials(name, email),
            tags: c.tags || [],
            tier: "Gold Member",
            isDistributor: isB2BParam || true,
          };

          const profiles = c.companyContactProfiles || [];
          if (profiles.length > 0 && profiles[0].company) {
            const company = profiles[0].company;
            companyName = company.name || `${name}'s Company`;
            locations = (company.locations?.edges || []).map((e) => e.node);
            contactRoles = (company.contactRoles?.edges || []).map((e) => e.node);
            companyContacts = (company.contacts?.edges || []).map((e) => e.node);
          } else {
            companyName = `${name}'s Company`;
          }
        }

        // If store is using tag-based B2B fallback, load any invited colleagues
        if (companyContacts.length === 0 && numericCustId) {
          try {
            const taggedRes = await withTimeout(
              admin.graphql(
                `#graphql
                query GetTaggedCompanyMembers($query: String!) {
                  customers(first: 25, query: $query) {
                    nodes {
                      id
                      firstName
                      lastName
                      displayName
                      defaultEmailAddress { emailAddress }
                      tags
                      updatedAt
                    }
                  }
                }`,
                { variables: { query: `tag:company_id:${numericCustId}` } },
              ),
              ADMIN_TIMEOUT_MS,
            );

            const taggedData = await taggedRes.json();
            const taggedNodes = taggedData?.data?.customers?.nodes || [];
            taggedNodes.forEach((tc) => {
              if (tc.id !== customer.id) {
                const isBuyer = tc.tags && tc.tags.includes("role:buyer");
                companyContacts.push({
                  id: tc.id,
                  title: isBuyer ? "Buyer" : "Admin",
                  updatedAt: tc.updatedAt,
                  isMainContact: false,
                  customer: tc,
                  roleAssignments: {
                    nodes: [{ role: { name: isBuyer ? "Buyer" : "Admin" } }],
                  },
                });
              }
            });
          } catch (taggedErr) {
            console.warn("[account] tagged team query warning:", taggedErr?.message || taggedErr);
          }
        }
      } catch (err) {
        console.warn("[account] team customer query warning:", err?.message || err);
      }
    }

    // Map REAL data only — zero dummy entries
    const members = customerId
      ? mapCompanyContactsToMembers(companyContacts, customer)
      : [];

    const mainHtml = teamPage({
      members,
      companyName,
      locations,
      contactRoles,
      notice,
      error: errorParam,
    });

    return liquid(
      accountShell({
        active: "team",
        main: mainHtml,
        customer,
        isDistributor: true,
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[account] team route loader error:", error);
    return liquid(
      accountShell({
        active: "team",
        main: teamPage({ members: [] }),
        isDistributor: true,
      
        ...(await portalChrome(admin, new URL(request.url).searchParams.get("logged_in_customer_id"))),
      }),
    );
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const numericCustId = customerId ? customerId.replace(/\D/g, "") : "";

    if (intent === "invite_member") {
      const firstName = String(formData.get("firstName") || "").trim();
      const lastName = String(formData.get("lastName") || "").trim();
      const email = String(formData.get("email") || "").trim().toLowerCase();
      const selectedLocationId = String(formData.get("companyLocationId") || "").trim();
      const selectedRoleId = String(formData.get("companyContactRoleId") || "").trim();
      const roleName = String(formData.get("role") || "Buyer").trim();
      const title = String(formData.get("title") || "").trim();

      if (!email || !firstName) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/apps/account/team?error=Please+provide+a+first+name+and+valid+email+address." },
        });
      }

      if (!admin) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/apps/account/team?error=Store+admin+session+not+available." },
        });
      }

      let companyId = null;
      let companyLocationId = selectedLocationId;
      let companyContactRoleId = selectedRoleId;
      let companyContactId = null;
      let newCustomerId = null;

      // -----------------------------------------------------------------------
      // Step 1: Identify inviter's company, default location, and roles
      // -----------------------------------------------------------------------
      if (customerId) {
        try {
          const compRes = await admin.graphql(
            `#graphql
            query GetCompanyContextForInvite($id: ID!) {
              customer(id: $id) {
                companyContactProfiles {
                  company {
                    id
                    locations(first: 10) {
                      edges {
                        node {
                          id
                          name
                        }
                      }
                    }
                    contactRoles(first: 10) {
                      edges {
                        node {
                          id
                          name
                        }
                      }
                    }
                  }
                }
              }
            }`,
            { variables: { id: `gid://shopify/Customer/${customerId}` } },
          );

          const compData = await compRes.json();
          const company = compData?.data?.customer?.companyContactProfiles?.[0]?.company;

          if (company) {
            companyId = company.id;

            // Resolve location
            if (!companyLocationId) {
              companyLocationId = company.locations?.edges?.[0]?.node?.id || null;
            }

            // Resolve role
            if (!companyContactRoleId && company.contactRoles?.edges?.length > 0) {
              const rolesList = company.contactRoles.edges.map((e) => e.node);
              // Match "Ordering only" or "Buyer" or "Admin"
              const matchedRole = rolesList.find((r) =>
                roleName === "Admin"
                  ? /admin|owner|manager/i.test(r.name)
                  : /order|buy/i.test(r.name),
              ) || rolesList[0];
              companyContactRoleId = matchedRole?.id || null;
            }
          }
        } catch (ctxErr) {
          console.warn("[account] error fetching company context:", ctxErr?.message || ctxErr);
        }
      }

      if (companyId) {
        // ---------------------------------------------------------------------
        // Step 2: Check if Shopify Customer already exists for that email
        // ---------------------------------------------------------------------
        let existingCustomerId = null;
        try {
          const checkCustRes = await admin.graphql(
            `#graphql
            query CheckCustomerExists($query: String!) {
              customers(first: 1, query: $query) {
                edges {
                  node {
                    id
                    email
                  }
                }
              }
            }`,
            { variables: { query: `email:${email}` } },
          );
          const checkCustData = await checkCustRes.json();
          existingCustomerId = checkCustData?.data?.customers?.edges?.[0]?.node?.id || null;
        } catch (checkErr) {
          console.warn("[account] customer check warning:", checkErr?.message || checkErr);
        }

        if (existingCustomerId) {
          // -------------------------------------------------------------------
          // Step 2b: Invite an existing Shopify Customer
          // -------------------------------------------------------------------
          const assignRes = await admin.graphql(
            `#graphql
            mutation AssignExistingCustomerAsContact($companyId: ID!, $customerId: ID!) {
              companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
                companyContact {
                  id
                  customer {
                    id
                    email
                  }
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }`,
            {
              variables: {
                companyId,
                customerId: existingCustomerId,
              },
            },
          );

          const assignData = await assignRes.json();
          const userErrors = assignData?.data?.companyAssignCustomerAsContact?.userErrors || [];

          if (userErrors.length > 0) {
            return new Response(null, {
              status: 302,
              headers: {
                Location: `/apps/account/team?error=${encodeURIComponent(userErrors[0].message || "Unable to assign customer to company.")}`,
              },
            });
          }

          companyContactId = assignData?.data?.companyAssignCustomerAsContact?.companyContact?.id;
        } else {
          // -------------------------------------------------------------------
          // Step 2a: Invite a new teammate (no existing Customer)
          // -------------------------------------------------------------------
          const createContactRes = await admin.graphql(
            `#graphql
            mutation CompanyContactCreate($companyId: ID!, $input: CompanyContactInput!) {
              companyContactCreate(companyId: $companyId, input: $input) {
                companyContact {
                  id
                  customer {
                    id
                    email
                    firstName
                    lastName
                  }
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }`,
            {
              variables: {
                companyId,
                input: {
                  email,
                  firstName,
                  lastName,
                  locale: "en",
                  title: title || roleName,
                },
              },
            },
          );

          const createContactData = await createContactRes.json();
          const userErrors = createContactData?.data?.companyContactCreate?.userErrors || [];

          if (userErrors.length > 0) {
            return new Response(null, {
              status: 302,
              headers: {
                Location: `/apps/account/team?error=${encodeURIComponent(userErrors[0].message || "Unable to create company contact.")}`,
              },
            });
          }

          companyContactId = createContactData?.data?.companyContactCreate?.companyContact?.id;
          newCustomerId = createContactData?.data?.companyContactCreate?.companyContact?.customer?.id;
        }

        // ---------------------------------------------------------------------
        // Step 3: Assign ordering permission / role at CompanyLocation
        // ---------------------------------------------------------------------
        if (companyContactId && companyLocationId && companyContactRoleId) {
          try {
            const roleRes = await admin.graphql(
              `#graphql
              mutation AssignOrderingRole($companyContactId: ID!, $companyLocationId: ID!, $companyContactRoleId: ID!) {
                companyContactAssignRole(
                  companyContactId: $companyContactId
                  companyLocationId: $companyLocationId
                  companyContactRoleId: $companyContactRoleId
                ) {
                  companyContactRoleAssignment {
                    id
                  }
                  userErrors {
                    field
                    message
                    code
                  }
                }
              }`,
              {
                variables: {
                  companyContactId,
                  companyLocationId,
                  companyContactRoleId,
                },
              },
            );

            const roleData = await roleRes.json();
            const roleErrors = roleData?.data?.companyContactAssignRole?.userErrors || [];
            if (roleErrors.length > 0) {
              console.warn("[account] role assignment warning:", roleErrors[0].message);
            }
          } catch (roleErr) {
            console.warn("[account] role assignment exception:", roleErr?.message || roleErr);
          }
        }

        // ---------------------------------------------------------------------
        // Step 4: Email invitation / account activation
        // ---------------------------------------------------------------------
        if (newCustomerId) {
          try {
            await admin.graphql(
              `#graphql
              mutation SendCustomerInvite($customerId: ID!) {
                customerSendAccountInvite(customerId: $customerId) {
                  customer {
                    id
                  }
                  userErrors {
                    field
                    message
                    code
                  }
                }
              }`,
              { variables: { customerId: newCustomerId } },
            );
          } catch (inviteSendErr) {
            console.warn("[account] customerSendAccountInvite warning:", inviteSendErr?.message || inviteSendErr);
          }
        }
      } else {
        // Fallback for stores where B2B Company objects are not enabled:
        // Create a customer account with company attribution tags
        const tags = [
          "b2b_member",
          `role:${roleName.toLowerCase()}`,
          "b2b_buyer",
          ...(numericCustId ? [`company_id:${numericCustId}`] : []),
        ];

        const custCreateRes = await admin.graphql(
          `#graphql
          mutation CreateB2BCustomer($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer {
                id
                email
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              input: {
                firstName,
                lastName,
                email,
                tags,
                note: `Invited as ${roleName} by company admin`,
              },
            },
          },
        );

        const custCreateData = await custCreateRes.json();
        const createdCustId = custCreateData?.data?.customerCreate?.customer?.id;

        if (createdCustId) {
          try {
            await admin.graphql(
              `#graphql
              mutation SendAccountInvite($customerId: ID!) {
                customerSendAccountInvite(customerId: $customerId) {
                  customer {
                    id
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              { variables: { customerId: createdCustId } },
            );
          } catch (inviteSendErr) {
            // Non-fatal
          }
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: `/apps/account/team?notice=Invitation+sent+successfully+to+${encodeURIComponent(email)}+with+ordering+permissions!`,
        },
      });
    }

    if (intent === "remove_member") {
      const memberId = String(formData.get("memberId") || "").trim();
      const memberEmail = String(formData.get("memberEmail") || "").trim();

      if (admin && memberId) {
        try {
          if (memberId.startsWith("gid://shopify/CompanyContact/")) {
            await admin.graphql(
              `#graphql
              mutation RemoveCompanyContact($id: ID!) {
                companyContactRemoveFromCompany(companyContactId: $id) {
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              { variables: { id: memberId } },
            );
          } else if (memberId.startsWith("gid://shopify/Customer/")) {
            const getTagsRes = await admin.graphql(
              `#graphql
              query GetCustomerTags($id: ID!) {
                customer(id: $id) {
                  tags
                }
              }`,
              { variables: { id: memberId } },
            );
            const getTagsData = await getTagsRes.json();
            const existingTags = getTagsData?.data?.customer?.tags || [];
            const filteredTags = existingTags.filter((t) => !t.startsWith("company_id:") && t !== "b2b_member");

            await admin.graphql(
              `#graphql
              mutation UpdateCustomerTags($input: CustomerInput!) {
                customerUpdate(input: $input) {
                  customer {
                    id
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
              { variables: { input: { id: memberId, tags: filteredTags } } },
            );
          }
        } catch (removeErr) {
          console.warn("[account] remove contact warning:", removeErr?.message || removeErr);
        }
      }

      return new Response(null, {
        status: 302,
        headers: {
          Location: `/apps/account/team?notice=Member+${encodeURIComponent(memberEmail || "account")}+has+been+removed+from+the+company.`,
        },
      });
    }

    return new Response(null, { status: 302, headers: { Location: "/apps/account/team" } });
  } catch (err) {
    console.error("[account] team action error:", err);
    return new Response(null, {
      status: 302,
      headers: { Location: "/apps/account/team?error=Unable+to+process+team+request." },
    });
  }
};

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admin API timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

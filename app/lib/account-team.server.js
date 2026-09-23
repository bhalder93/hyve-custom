/**
 * Team Members page for the B2B portal.
 *
 * Implements the design from the user mockup:
 *   - Header: "Team Members", "Manage your team's access and roles", and "+ Invite Member" button
 *   - Table: MEMBER (avatar box + bold name), EMAIL, ROLE (Admin/Buyer pills), LAST ACTIVE, and action (You / •••)
 *   - Full Invite Member modal with First/Last Name, Email, Role (Buyer/Admin), and Job Title
 *   - Three-dots (•••) action dropdown with Edit Role and Remove Member functionality
 *   - Responsive, production-grade HTML/CSS/JS
 */

import { esc } from "./account-shell.server";

export const ROLES = {
  ADMIN: "Admin",
  BUYER: "Buyer",
};

/**
 * Whether a company contact may manage the team.
 *
 * Shopify decides this, not us. A contact holds a role at each company
 * location, and the two Shopify defines are "Location admin" and "Ordering
 * only". Only an admin role may invite or remove — being the main contact is a
 * label, not a permission, and a customer tag is not one either, so neither is
 * read here.
 *
 * @param {object} node a CompanyContact, with its roleAssignments
 */
export function isTeamAdmin(node) {
  const roleNodes =
    node?.roleAssignments?.edges?.map((e) => e.node) || node?.roleAssignments?.nodes || [];
  return roleNodes.some((r) =>
    /admin|owner|manager/i.test(r?.role?.name || r?.companyContactRole?.name || ""),
  );
}

const CALLER_ROLE_QUERY = `#graphql
  query TeamCallerRole($id: ID!) {
    customer(id: $id) {
      companyContactProfiles {
        roleAssignments(first: 10) {
          edges { node { role { name } } }
        }
      }
    }
  }`;

/**
 * Whether the signed-in customer may invite or remove. Asked of Shopify on
 * every such request: hiding the buttons stops the honest, this stops the rest.
 *
 * @param {string} numericCustomerId the id from `logged_in_customer_id`
 */
export async function canManageTeam(admin, numericCustomerId) {
  if (!admin || !numericCustomerId) return false;

  try {
    const response = await admin.graphql(CALLER_ROLE_QUERY, {
      variables: { id: `gid://shopify/Customer/${numericCustomerId}` },
    });
    const body = await response.json();

    if (body?.errors) {
      console.warn("[account] team role check failed", JSON.stringify(body.errors));
      return false;
    }

    return (body?.data?.customer?.companyContactProfiles || []).some(isTeamAdmin);
  } catch (error) {
    console.warn("[account] team role check failed", error?.message || error);
    return false;
  }
}

export function getRoleDescription(name = "") {
  const n = String(name).toLowerCase();
  if (n.includes("order")) {
    return "Can browse products, view contract pricing, and submit wholesale orders.";
  }
  if (n.includes("admin") || n.includes("owner") || n.includes("manager")) {
    return "Full access to manage team members, shipping addresses, and company settings.";
  }
  if (n.includes("buyer") || n.includes("purchas")) {
    return "Authorized buyer with wholesale ordering permissions.";
  }
  return "Authorized company contact for wholesale account.";
}

/**
 * Format relative active time
 */
export function formatRelativeTime(dateVal) {
  if (!dateVal) return "Recently";
  try {
    const d = new Date(dateVal);
    const now = new Date();
    const diffMs = now - d;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return "Now";
    if (diffHours === 1) return "1 hour ago";
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
  } catch (e) {
    return "Recently";
  }
}

/**
 * Compute 2-letter initials from name or email
 */
export function getInitials(name, email) {
  if (name && typeof name === "string") {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    if (parts[0].length >= 2) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    if (parts[0].length === 1) {
      return parts[0].toUpperCase();
    }
  }
  if (email && typeof email === "string") {
    return email.slice(0, 2).toUpperCase();
  }
  return "MB";
}

/**
 * Map Shopify CompanyContact nodes to member objects.
 * Uses ONLY real data — no dummy sample names.
 */
export function mapCompanyContactsToMembers(contactNodes = [], currentCustomer = null) {
  const currentCustomerEmail = (currentCustomer?.email || "").toLowerCase();
  const members = [];
  let foundCurrentCustomer = false;

  if (Array.isArray(contactNodes) && contactNodes.length > 0) {
    contactNodes.forEach((node) => {
      const cust = node.customer || {};
      const first = cust.firstName || "";
      const last = cust.lastName || "";
      const name = cust.displayName || `${first} ${last}`.trim() || node.title || "Team Member";
      const email = cust.email || cust.defaultEmailAddress?.emailAddress || "";
      const isCurrentCustomer = Boolean(currentCustomerEmail && email.toLowerCase() === currentCustomerEmail);

      if (isCurrentCustomer) {
        foundCurrentCustomer = true;
      }

      const role = isTeamAdmin(node) ? ROLES.ADMIN : ROLES.BUYER;

      const lastActive = isCurrentCustomer
        ? "Now"
        : formatRelativeTime(cust.updatedAt || node.updatedAt);

      members.push({
        id: node.id,
        customerId: cust.id || "",
        name,
        email,
        initials: getInitials(name, email),
        role,
        lastActive,
        isCurrentCustomer,
        title: node.title || "",
      });
    });
  }

  // If current logged-in customer is not in the list, include them as the primary contact
  if (!foundCurrentCustomer && currentCustomer && currentCustomer.email) {
    members.unshift({
      id: currentCustomer.id || "current_user",
      customerId: currentCustomer.id || "",
      name: currentCustomer.name || "Team Admin",
      email: currentCustomer.email,
      initials: currentCustomer.initials || getInitials(currentCustomer.name, currentCustomer.email),
      role: ROLES.ADMIN,
      lastActive: "Now",
      isCurrentCustomer: true,
      title: "Primary Contact",
    });
  }

  return members;
}

/**
 * Render the complete Team Members page HTML
 */
export function teamPage({
  members = [],
  companyName = "Company Account",
  locations = [],
  contactRoles = [],
  notice = null,
  error = null,
  canManage = false,
}) {
  const hasMembers = Array.isArray(members) && members.length > 0;
  const memberRowsHtml = hasMembers ? members.map((m) => renderMemberRow(m, canManage)).join("") : "";
  const isOnlyOneMember = members.length === 1;

  const hasMultipleLocations = locations && locations.length > 1;
  const defaultLocationId = locations && locations.length > 0 ? locations[0].id : "";

  return `
  ${TEAM_STYLES}
  <div class="hyve-team">
    ${notice ? `<div class="hyve-team__alert hyve-team__alert--success">${esc(notice)}</div>` : ""}
    ${error ? `<div class="hyve-team__alert hyve-team__alert--error">${esc(error)}</div>` : ""}

    <!-- Header matching mockup -->
    <div class="hyve-team__header">
      <div class="hyve-team__header-text">
        <h1 class="hyve-team__title">Team Members</h1>
        <p class="hyve-team__subtitle">Manage your team's access and roles</p>
      </div>

      ${canManage ? `
      <button type="button" class="hyve-team__cta-btn" onclick="openInviteModal()">
        ${icoUserPlus()}
        <span>Invite Member</span>
      </button>
      ` : ""}
    </div>

    <!-- Main Table Card -->
    <div class="hyve-team__card">
      ${hasMembers ? `
      <div class="hyve-team__table-container">
        <table class="hyve-team__table">
          <thead>
            <tr>
              <th class="hyve-th-member">MEMBER</th>
              <th class="hyve-th-email">EMAIL</th>
              <th class="hyve-th-role">ROLE</th>
              <th class="hyve-th-active">LAST ACTIVE</th>
              <th class="hyve-th-action"></th>
            </tr>
          </thead>
          <tbody>
            ${memberRowsHtml}
          </tbody>
        </table>
      </div>
      ${isOnlyOneMember && canManage ? `
      <div class="hyve-team__solo-banner">
        <span>You are currently the only member in this team. Use <strong>+ Invite Member</strong> above to add colleagues.</span>
      </div>
      ` : ""}
      ${!canManage ? `
      <div class="hyve-team__solo-banner">
        <span>Only an account admin can invite or remove team members. Ask your admin if you need a colleague added.</span>
      </div>
      ` : ""}
      ` : `
      <div class="hyve-team__empty">
        <div class="hyve-team__empty-icon">${icoUsersEmpty()}</div>
        <h3 class="hyve-team__empty-title">No team members found</h3>
        <p class="hyve-team__empty-desc">${canManage
          ? `You don't have any members added yet. Click "+ Invite Member" to invite colleagues to collaborate on quotes and orders.`
          : `Only an account admin can invite team members. Ask your admin if you need a colleague added.`}</p>
        ${canManage ? `
        <button type="button" class="hyve-team__cta-btn" onclick="openInviteModal()">
          ${icoUserPlus()}
          <span>Invite Member</span>
        </button>
        ` : ""}
      </div>
      `}
    </div>

    ${canManage ? `
    <!-- Invite Member Modal -->
    <div class="hyve-modal" id="inviteMemberModal" style="display: none;">
      <div class="hyve-modal__backdrop" onclick="closeInviteModal()"></div>
      <div class="hyve-modal__dialog">
        <div class="hyve-modal__header">
          <div>
            <h2 class="hyve-modal__title">Invite Team Member</h2>
            <p class="hyve-modal__subtitle">Add a colleague to ${esc(companyName)} to collaborate on wholesale orders and quotes.</p>
          </div>
          <button type="button" class="hyve-modal__close" onclick="closeInviteModal()">&times;</button>
        </div>

        <form method="post" class="hyve-modal__form">
          <input type="hidden" name="intent" value="invite_member" />
          ${!hasMultipleLocations && defaultLocationId ? `<input type="hidden" name="companyLocationId" value="${esc(defaultLocationId)}" />` : ""}

          <div class="hyve-form-row">
            <div class="hyve-form-group">
              <label class="hyve-form-label">First Name *</label>
              <input
                type="text"
                name="firstName"
                class="hyve-form-input"
                placeholder="e.g. James"
                required
              />
            </div>
            <div class="hyve-form-group">
              <label class="hyve-form-label">Last Name *</label>
              <input
                type="text"
                name="lastName"
                class="hyve-form-input"
                placeholder="e.g. Tan"
                required
              />
            </div>
          </div>

          <div class="hyve-form-group">
            <label class="hyve-form-label">Work Email Address *</label>
            <input
              type="email"
              name="email"
              class="hyve-form-input"
              placeholder="colleague@company.com"
              required
            />
          </div>

          ${hasMultipleLocations ? `
          <div class="hyve-form-group">
            <label class="hyve-form-label">Company Location</label>
            <select name="companyLocationId" class="hyve-form-input">
              ${locations.map((loc) => `<option value="${esc(loc.id)}">${esc(loc.name)}</option>`).join("")}
            </select>
          </div>
          ` : ""}

          <div class="hyve-form-group">
            <label class="hyve-form-label">Role &amp; Permissions</label>
            <div class="hyve-role-options">
              ${contactRoles && contactRoles.length > 0 ? contactRoles.map((r, idx) => `
                <label class="hyve-role-option">
                  <input type="radio" name="companyContactRoleId" value="${esc(r.id)}" ${idx === 0 ? "checked" : ""} />
                  <div class="hyve-role-option__body">
                    <div class="hyve-role-option__title">${esc(r.name)}</div>
                    <div class="hyve-role-option__desc">${esc(getRoleDescription(r.name))}</div>
                  </div>
                </label>
              `).join("") : `
                <label class="hyve-role-option">
                  <input type="radio" name="role" value="Buyer" checked />
                  <div class="hyve-role-option__body">
                    <div class="hyve-role-option__title">Buyer (Ordering only)</div>
                    <div class="hyve-role-option__desc">Can browse products, view contract pricing, and place wholesale draft orders.</div>
                  </div>
                </label>

                <label class="hyve-role-option">
                  <input type="radio" name="role" value="Admin" />
                  <div class="hyve-role-option__body">
                    <div class="hyve-role-option__title">Admin (Location admin)</div>
                    <div class="hyve-role-option__desc">Full access to manage team members, addresses, and company settings.</div>
                  </div>
                </label>
              `}
            </div>
          </div>

          <div class="hyve-form-group">
            <label class="hyve-form-label">Job Title / Department (Optional)</label>
            <input
              type="text"
              name="title"
              class="hyve-form-input"
              placeholder="e.g. Purchasing Specialist"
            />
          </div>

          <div class="hyve-modal__footer">
            <button type="button" class="hyve-modal__btn hyve-modal__btn--secondary" onclick="closeInviteModal()">
              Cancel
            </button>
            <button type="submit" class="hyve-modal__btn hyve-modal__btn--primary">
              Send Invitation
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Member Actions Dropdown / Modal -->
    <div class="hyve-modal" id="memberActionsModal" style="display: none;">
      <div class="hyve-modal__backdrop" onclick="closeMemberActionsModal()"></div>
      <div class="hyve-modal__dialog hyve-modal__dialog--sm">
        <div class="hyve-modal__header">
          <h3 class="hyve-modal__title" id="actionMemberName">Member Settings</h3>
          <button type="button" class="hyve-modal__close" onclick="closeMemberActionsModal()">&times;</button>
        </div>
        <div class="hyve-member-actions-content">
          <p class="hyve-member-actions-email" id="actionMemberEmail"></p>

          <p class="hyve-member-actions-note">
            They lose access to the company's orders, quotes, invoices and artwork straight away.
          </p>

          <form method="post" id="removeMemberForm">
            <input type="hidden" name="intent" value="remove_member" />
            <input type="hidden" name="memberId" class="js-action-member-id" value="" />
            <input type="hidden" name="memberEmail" class="js-action-member-email" value="" />

            <button type="submit" class="hyve-btn-danger">
              ${icoTrash()}
              <span>Remove from Company</span>
            </button>
          </form>
        </div>
      </div>
    </div>
    ` : ""}
  </div>

  ${renderClientScript()}
  `;
}

function renderMemberRow(m, canManage = false) {
  const roleClass = m.role === ROLES.ADMIN ? "hyve-role-pill--admin" : "hyve-role-pill--buyer";

  const actionColHtml = m.isCurrentCustomer
    ? `<span class="hyve-badge-you">You</span>`
    : !canManage
    ? ""
    : `
      <button
        type="button"
        class="hyve-btn-more"
        onclick="openMemberActions('${esc(m.id)}', '${esc(m.name)}', '${esc(m.email)}')"
        aria-label="Options for ${esc(m.name)}"
      >
        •••
      </button>`;

  return `
    <tr class="hyve-tr-member">
      <!-- Member Name + Avatar -->
      <td class="hyve-td-member">
        <div class="hyve-member-info">
          <div class="hyve-avatar-box">
            ${esc(m.initials)}
          </div>
          <span class="hyve-member-name">${esc(m.name)}</span>
        </div>
      </td>

      <!-- Email -->
      <td class="hyve-td-email">
        <span class="hyve-member-email">${esc(m.email)}</span>
      </td>

      <!-- Role -->
      <td class="hyve-td-role">
        <span class="hyve-role-pill ${roleClass}">${esc(m.role)}</span>
      </td>

      <!-- Last Active -->
      <td class="hyve-td-active">
        <span class="hyve-last-active">${esc(m.lastActive)}</span>
      </td>

      <!-- Action -->
      <td class="hyve-td-action">
        ${actionColHtml}
      </td>
    </tr>
  `;
}

/* -------------------------------------------------------------------------- */
/* Client Script                                                              */
/* -------------------------------------------------------------------------- */

function renderClientScript() {
  return `
  <script>
    (function() {
      window.openInviteModal = function() {
        var m = document.getElementById('inviteMemberModal');
        if (m) m.style.display = 'flex';
      };

      window.closeInviteModal = function() {
        var m = document.getElementById('inviteMemberModal');
        if (m) m.style.display = 'none';
      };

      window.openMemberActions = function(id, name, email) {
        var m = document.getElementById('memberActionsModal');
        var nameEl = document.getElementById('actionMemberName');
        var emailEl = document.getElementById('actionMemberEmail');

        if (nameEl) nameEl.textContent = name;
        if (emailEl) emailEl.textContent = email;

        var ids = document.querySelectorAll('.js-action-member-id');
        for (var i = 0; i < ids.length; i++) ids[i].value = id;
        var emails = document.querySelectorAll('.js-action-member-email');
        for (var j = 0; j < emails.length; j++) emails[j].value = email;

        if (m) m.style.display = 'flex';
      };

      window.closeMemberActionsModal = function() {
        var m = document.getElementById('memberActionsModal');
        if (m) m.style.display = 'none';
      };

      // Close on Escape key
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          closeInviteModal();
          closeMemberActionsModal();
        }
      });
    })();
  </script>`;
}

/* -------------------------------------------------------------------------- */
/* SVG Icons                                                                  */
/* -------------------------------------------------------------------------- */

function icoUserPlus() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
}

function icoTrash() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
}

function icoUsersEmpty() {
  return `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const TEAM_STYLES = `
<style>
  .hyve-team {
    max-width: 1000px;
    margin: 0 auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Alerts */
  .hyve-team__alert {
    padding: 12px 18px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .hyve-team__alert--success {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #065f46;
  }
  .hyve-team__alert--error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
  }

  /* Header */
  .hyve-team__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .hyve-team__title {
    font-size: 24px;
    font-weight: 800;
    color: #0f172a;
    margin: 0 0 4px 0;
    line-height: 1.2;
  }
  .hyve-team__subtitle {
    font-size: 13.5px;
    color: #64748b;
    margin: 0;
  }
  .hyve-team__cta-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #84f09d;
    color: #0f172a;
    border: none;
    border-radius: 8px;
    padding: 9px 18px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .hyve-team__cta-btn:hover {
    background: #6ee7b7;
    transform: translateY(-1px);
  }

  /* Main Table Card */
  .hyve-team__card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
    overflow: hidden;
  }
  .hyve-team__table-container {
    width: 100%;
    overflow-x: auto;
  }
  .hyve-team__table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }

  /* Table Headers */
  .hyve-team__table thead th {
    padding: 16px 24px;
    font-size: 11.5px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid #f1f5f9;
    background: #ffffff;
  }
  .hyve-th-member { width: 30%; }
  .hyve-th-email { width: 30%; }
  .hyve-th-role { width: 15%; }
  .hyve-th-active { width: 15%; }
  .hyve-th-action { width: 10%; text-align: right; }

  /* Table Rows */
  .hyve-tr-member {
    border-bottom: 1px solid #f1f5f9;
    transition: background-color 0.1s ease;
  }
  .hyve-tr-member:last-child {
    border-bottom: none;
  }
  .hyve-tr-member:hover {
    background-color: #fafbfc;
  }
  .hyve-team__table tbody td {
    padding: 18px 24px;
    vertical-align: middle;
    font-size: 13.5px;
  }

  /* Member Column */
  .hyve-member-info {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .hyve-avatar-box {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    background: #f1f5f9;
    color: #475569;
    font-weight: 700;
    font-size: 12.5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: -0.02em;
  }
  .hyve-member-name {
    font-weight: 700;
    color: #0f172a;
    font-size: 14px;
  }

  /* Email Column */
  .hyve-member-email {
    color: #475569;
    font-size: 13.5px;
  }

  /* Role Badges */
  .hyve-role-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
  }
  .hyve-role-pill--admin {
    background: #e0f2fe;
    color: #0284c7;
  }
  .hyve-role-pill--buyer {
    background: #f1f5f9;
    color: #64748b;
  }

  /* Last Active Column */
  .hyve-last-active {
    color: #64748b;
    font-size: 13px;
  }

  /* Action Column */
  .hyve-td-action {
    text-align: right;
  }
  .hyve-badge-you {
    color: #94a3b8;
    font-size: 13px;
    font-weight: 600;
  }
  .hyve-btn-more {
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 16px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    letter-spacing: 2px;
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .hyve-btn-more:hover {
    color: #0f172a;
    background: #f1f5f9;
  }

  /* Solo Member Banner */
  .hyve-team__solo-banner {
    padding: 16px 24px;
    background: #f8fafc;
    border-top: 1px solid #f1f5f9;
    color: #64748b;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .hyve-team__solo-banner strong {
    color: #0f172a;
  }

  /* Empty State */
  .hyve-team__empty {
    padding: 60px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: 460px;
    margin: 0 auto;
  }
  .hyve-team__empty-icon {
    margin-bottom: 16px;
    opacity: 0.6;
  }
  .hyve-team__empty-title {
    font-size: 17px;
    font-weight: 800;
    color: #0f172a;
    margin: 0 0 8px 0;
  }
  .hyve-team__empty-desc {
    font-size: 13px;
    color: #64748b;
    line-height: 1.55;
    margin: 0 0 22px 0;
  }

  /* Modal Styles */
  .hyve-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
  }
  .hyve-modal__backdrop {
    display: block !important;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(4px);
  }
  .hyve-modal__dialog {
    position: relative;
    background: #ffffff;
    border-radius: 16px;
    width: 100%;
    max-width: 520px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    z-index: 10;
    overflow: hidden;
  }
  .hyve-modal__dialog--sm {
    max-width: 400px;
  }
  .hyve-modal__header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 20px 24px;
    border-bottom: 1px solid #e2e8f0;
  }
  .hyve-modal__title {
    font-size: 17px;
    font-weight: 800;
    color: #0f172a;
    margin: 0;
  }
  .hyve-modal__subtitle {
    font-size: 12.5px;
    color: #64748b;
    margin: 4px 0 0 0;
    line-height: 1.4;
  }
  .hyve-modal__close {
    background: none;
    border: none;
    font-size: 22px;
    color: #94a3b8;
    cursor: pointer;
    line-height: 1;
  }
  .hyve-modal__close:hover {
    color: #0f172a;
  }
  .hyve-modal__form {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .hyve-form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hyve-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .hyve-form-label {
    font-size: 12.5px;
    font-weight: 600;
    color: #334155;
  }
  .hyve-form-input {
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 9px 12px;
    font-size: 13px;
    color: #0f172a;
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s ease;
  }
  .hyve-form-input:focus {
    border-color: #38bdf8;
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
  }

  /* Role Selection Cards */
  .hyve-role-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hyve-role-option {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .hyve-role-option:hover {
    background: #f8fafc;
    border-color: #cbd5e1;
  }
  .hyve-role-option input[type="radio"] {
    margin-top: 3px;
    cursor: pointer;
    accent-color: #0f172a;
  }
  .hyve-role-option__title {
    font-size: 13px;
    font-weight: 700;
    color: #0f172a;
  }
  .hyve-role-option__desc {
    font-size: 11.5px;
    color: #64748b;
    margin-top: 2px;
    line-height: 1.35;
  }

  /* Modal Footer */
  .hyve-modal__footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 8px;
  }
  .hyve-modal__btn {
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    border: none;
  }
  .hyve-modal__btn--secondary {
    background: #f1f5f9;
    color: #475569;
  }
  .hyve-modal__btn--primary {
    background: #0f172a;
    color: #ffffff;
  }
  .hyve-modal__btn--primary:hover {
    background: #1e293b;
  }

  /* Member Actions Popover Content */
  .hyve-member-actions-content {
    padding: 20px 24px;
  }
  .hyve-member-actions-email {
    font-size: 13px;
    color: #64748b;
    margin: 0 0 16px 0;
  }
  .hyve-btn-danger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 16px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #dc2626;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .hyve-btn-danger:hover {
    background: #fee2e2;
    border-color: #fca5a5;
  }
  .hyve-member-actions-note {
    font-size: 12.5px;
    color: #64748b;
    line-height: 1.5;
    margin: 0 0 14px 0;
  }


  /* Responsive adjustments */
  @media (max-width: 768px) {
    .hyve-th-active, .hyve-td-active {
      display: none;
    }
    .hyve-team__table thead th,
    .hyve-team__table tbody td {
      padding: 14px 16px;
    }
    .hyve-form-row {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 520px) {
    .hyve-th-email, .hyve-td-email {
      display: none;
    }
    .hyve-member-info {
      gap: 10px;
    }
    .hyve-avatar-box {
      width: 32px;
      height: 32px;
      font-size: 11.5px;
    }
    .hyve-member-name {
      font-size: 13px;
    }
  }
</style>`;

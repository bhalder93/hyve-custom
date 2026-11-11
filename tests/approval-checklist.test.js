import test from "node:test";
import assert from "node:assert/strict";
import { approvalMissing } from "../app/lib/approval-checklist.js";
import { distributorCurrency } from "../app/lib/company-currency.server.js";

const SG_FORMAT = {
  name: "Singapore",
  code: "SG",
  phonePrefix: 65,
  rows: [["address1"], ["address2"], ["zip"]],
  labels: {
    address1: "Address",
    address2: "Apartment, suite, etc",
    zip: "Postal code",
  },
  zones: [],
};

const US_FORMAT = {
  name: "United States",
  code: "US",
  phonePrefix: 1,
  rows: [["address1"], ["address2"], ["city", "province", "zip"]],
  labels: {
    address1: "Address",
    address2: "Apartment, suite, etc",
    city: "City",
    province: "State",
    zip: "ZIP code",
  },
  zones: [{ code: "CA", name: "California" }, { code: "NY", name: "New York" }],
};

test("approvalMissing allows approving without company shipping address and phone", () => {
  const missing = approvalMissing(SG_FORMAT, {
    address1: "",
    address2: "",
    zip: "",
    phone: "",
    salesRep: "Sarah Connor",
    salesRepEmail: "sarah@hyve.com",
    salesRepPhone: "",
  });

  assert.deepEqual(missing, []);
});

test("approvalMissing still requires sales rep and valid email when address is omitted", () => {
  const missing = approvalMissing(SG_FORMAT, {
    address1: "",
    salesRep: "",
    salesRepEmail: "not-an-email",
  });

  assert.ok(missing.includes("Sales representative name"));
  assert.ok(missing.includes("a valid sales representative email"));
  assert.equal(missing.some((m) => m.toLowerCase().includes("address")), false);
  assert.equal(missing.some((m) => m.toLowerCase().includes("phone")), false);
});

test("approvalMissing validates required address fields if street address is provided", () => {
  const missing = approvalMissing(US_FORMAT, {
    address1: "123 Market St",
    city: "",
    province: "",
    zip: "",
    salesRep: "Sarah Connor",
    salesRepEmail: "sarah@hyve.com",
  });

  assert.ok(missing.includes("City"));
  assert.ok(missing.includes("State"));
  assert.ok(missing.includes("ZIP code"));
  // Phone should still be optional even when address is provided
  assert.equal(missing.some((m) => m.toLowerCase().includes("phone")), false);
});

test("approvalMissing validates phone format if a phone is entered", () => {
  const missing = approvalMissing(SG_FORMAT, {
    address1: "",
    phone: "123", // invalid Singapore number
    salesRep: "Sarah Connor",
    salesRepEmail: "sarah@hyve.com",
  });

  assert.ok(missing.some((m) => m.includes("valid Singapore phone number")));
});

test("approvalMissing passes when a valid complete address and valid phone are provided", () => {
  const missing = approvalMissing(SG_FORMAT, {
    address1: "10 Bayfront Ave",
    zip: "018956",
    phone: "+65 6688 8868",
    salesRep: "Sarah Connor",
    salesRepEmail: "sarah@hyve.com",
  });

  assert.deepEqual(missing, []);
});

test("approvalMissing passes when a valid complete address is provided without phone", () => {
  const missing = approvalMissing(SG_FORMAT, {
    address1: "10 Bayfront Ave",
    zip: "018956",
    phone: "",
    salesRep: "Sarah Connor",
    salesRepEmail: "sarah@hyve.com",
  });

  assert.deepEqual(missing, []);
});

test("distributorCurrency maps SG and Singapore to SGD, others and fallback to USD", () => {
  assert.equal(distributorCurrency("SG"), "SGD");
  assert.equal(distributorCurrency("Singapore"), "SGD");
  assert.equal(distributorCurrency("US"), "USD");
  assert.equal(distributorCurrency("HK"), "USD");
  assert.equal(distributorCurrency(""), "USD");
});


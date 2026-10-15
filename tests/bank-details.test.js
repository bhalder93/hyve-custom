import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_NAME,
  bankCountryFor,
  bankAccountFor,
  normalizeBankAccounts,
} from "../app/lib/bank-details.server.js";

function valueFor(account, label) {
  return account.rows.find(([rowLabel]) => rowLabel === label)?.[1];
}

test("all market bank accounts use the current legal account name", () => {
  const accounts = normalizeBankAccounts({});

  for (const account of Object.values(accounts)) {
    assert.equal(valueFor(account, "Account Name"), "HYVE PROMO PTE. LTD.");
  }
});

test("Hong Kong falls back to the populated DBS USD account from legacy empty settings", () => {
  const account = bankAccountFor("HK", {
    DBS_USD: { heading: "For Payment in USD", rows: [] },
  });

  assert.equal(account.heading, "For Payment in USD");
  assert.equal(valueFor(account, "Account Number"), "8853796394");
  assert.equal(valueFor(account, "Bank Code"), "7171");
  assert.equal(valueFor(account, "Branch Code"), "072");
  assert.equal(valueFor(account, "SWIFT/BIC"), "DBSSSGSG");
});

test("US, Singapore and EU route to their configured bank accounts", () => {
  const us = bankAccountFor("US");
  const singapore = bankAccountFor("SG");
  const denmark = bankAccountFor("DK");

  assert.equal(valueFor(us, "Account Number"), "8489434183");
  assert.equal(valueFor(us, "ACH Routing Number"), "026073150");
  assert.equal(valueFor(us, "Fedwire Routing Number"), "026073008");
  assert.equal(valueFor(singapore, "Account Number"), "8853796394");
  assert.equal(valueFor(denmark, "Bank Name"), "Banking Circle S.A.");
  assert.equal(valueFor(denmark, "Account Number"), "0059357820");
  assert.equal(valueFor(denmark, "Bank Code"), "8900");
  assert.equal(valueFor(denmark, "SWIFT/BIC"), "SXPYDKKK");
});

test("bank country selection includes a company location shipping country", () => {
  assert.equal(
    bankCountryFor({ locationShippingCountry: "US", fallbackCountry: "VN" }),
    "US",
  );
});

test("bank country selection prefers shipping destination and normalizes codes", () => {
  assert.equal(
    bankCountryFor({ shippingCountry: " sg ", billingCountry: "US" }),
    "SG",
  );
});

test("custom account values are preserved except for the required legal account name", () => {
  const account = bankAccountFor("HK", {
    DBS_USD: {
      heading: "For Payment in USD",
      rows: [
        ["Account Name", "Hyve Promo Pte Ltd"],
        ["Account Number", "custom-number"],
      ],
    },
  });

  assert.equal(valueFor(account, "Account Name"), ACCOUNT_NAME);
  assert.equal(valueFor(account, "Account Number"), "custom-number");
  assert.equal(valueFor(account, "SWIFT/BIC"), "DBSSSGSG");
});

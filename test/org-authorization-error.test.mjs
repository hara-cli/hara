import assert from "node:assert/strict";
import test from "node:test";
import {
  isOrganizationAuthorizationRejection,
  organizationAuthorizationRecoveryMessage,
} from "../dist/org-fleet/errors.js";

test("Control 401 and 403 role failures are classified as organization authorization failures", () => {
  assert.equal(isOrganizationAuthorizationRejection(new Error("organization role sync failed with HTTP 401")), true);
  assert.equal(isOrganizationAuthorizationRejection(new Error("organization policy sync failed with HTTP 403")), true);
  assert.equal(isOrganizationAuthorizationRejection(new Error("organization role sync failed with HTTP 500")), false);
  assert.equal(isOrganizationAuthorizationRejection(new Error("provider returned HTTP 401")), false);
});

test("organization authorization recovery copy does not expose the raw endpoint response", () => {
  const message = organizationAuthorizationRecoveryMessage();
  assert.match(message, /re-enroll/i);
  assert.doesNotMatch(message, /HTTP|Bearer|token/i);
});

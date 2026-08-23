import assert from "node:assert/strict";
import { retryAfterMs } from "./src/retry-after.mjs";
import { requestId } from "./src/request-id.mjs";

const now = Date.parse("2025-01-01T00:00:00.000Z");
const failures = [];

try {
  assert.equal(retryAfterMs("3", now), 3_000);
  assert.equal(retryAfterMs("Wed, 01 Jan 2025 00:00:02 GMT", now), 2_000);
  assert.equal(retryAfterMs("Wed, 01 Jan 2024 00:00:00 GMT", now), 0);
  assert.equal(retryAfterMs("not-a-delay", now), 0);
} catch {
  failures.push("retry-after HTTP-date normalization");
}

try {
  assert.equal(requestId({ "X-Request-Id": "upper" }), "upper");
  assert.equal(requestId({ "x-request-id": "lower" }), "lower");
  assert.equal(requestId({ "X-REQUEST-ID": "loud" }), "loud");
  assert.equal(requestId({}), "");
} catch {
  failures.push("request-id case-insensitive lookup");
}

if (failures.length > 0) {
  console.error(`fixture verification failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("fixture verification passed: parallel diagnosis integrated outcome");
}

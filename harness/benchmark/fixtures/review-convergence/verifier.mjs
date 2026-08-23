import assert from "node:assert/strict";
import { redactHeaders } from "./src/redact-headers.mjs";

const failures = [];
try {
  const source = {
    Authorization: "Bearer top-secret",
    cookie: "session=private",
    "Set-Cookie": "next=private",
    "X-Trace": "safe",
  };
  const result = redactHeaders(source);
  assert.deepEqual(result, {
    Authorization: "[redacted]",
    cookie: "[redacted]",
    "Set-Cookie": "[redacted]",
    "X-Trace": "safe",
  });
  assert.deepEqual(source, {
    Authorization: "Bearer top-secret",
    cookie: "session=private",
    "Set-Cookie": "next=private",
    "X-Trace": "safe",
  });
  assert.deepEqual(redactHeaders(Object.assign(Object.create(null), { COOKIE: "private" })), { COOKIE: "[redacted]" });
  assert.deepEqual(redactHeaders(null), {});
} catch {
  failures.push("case-insensitive immutable secret-header redaction");
}

if (failures.length > 0) {
  console.error(`fixture verification failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("fixture verification passed: review convergence outcome");
}

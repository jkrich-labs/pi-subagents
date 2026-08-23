import assert from "node:assert/strict";
import { endpointPort } from "./src/endpoint-port.mjs";
import { canonicalTags } from "./src/canonical-tags.mjs";

const failures = [];
try {
  assert.equal(endpointPort("http://service.example:8080/path"), 8080);
  assert.equal(endpointPort("http://service.example/path"), 80);
  assert.equal(endpointPort("https://service.example/path"), 443);
  assert.equal(endpointPort("ftp://service.example:21"), 0);
  assert.equal(endpointPort("not an endpoint"), 0);
} catch {
  failures.push("endpoint-port HTTP(S) normalization");
}

try {
  assert.deepEqual(canonicalTags([" Alpha ", "beta", "ALPHA", "", 7, "Beta "]), ["alpha", "beta"]);
  assert.deepEqual(canonicalTags(undefined), []);
} catch {
  failures.push("canonical-tags trim lowercase unique filtering");
}

if (failures.length > 0) {
  console.error(`fixture verification failed: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("fixture verification passed: parallel implementation integrated outcome");
}

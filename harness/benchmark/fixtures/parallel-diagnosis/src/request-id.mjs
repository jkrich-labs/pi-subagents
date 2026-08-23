/** Extract the upstream request id from a plain HTTP header object. */
export function requestId(headers) {
  return headers?.["x-request-id"] ?? "";
}

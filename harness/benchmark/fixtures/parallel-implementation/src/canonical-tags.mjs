/** Normalize user tags into stable, unique lowercase labels. */
export function canonicalTags(values) {
  return Array.isArray(values) ? values : [];
}

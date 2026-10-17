import type { PortEntry, PortColumnField } from "../types/port";
import type { PortColor, PortColorRule } from "../types/settings";
import type { EntryDisplayResolver } from "./serviceKnowledge";
import { matchesFacetFilters } from "./portFacets";

function matches(
  entry: PortEntry,
  rule: PortColorRule,
  displayFor?: EntryDisplayResolver,
): boolean {
  return rule.enabled && matchesFacetFilters(entry, rule.filters, displayFor);
}
/** Rules apply in user order; an explicit empty condition matches all rows. */
export function cellColor(
  entry: PortEntry,
  field: PortColumnField,
  rules: PortColorRule[],
  displayFor?: EntryDisplayResolver,
): PortColor | null {
  return (
    rules.find(
      (rule) =>
        (rule.target.kind === "row" || rule.target.fields.includes(field)) &&
        matches(entry, rule, displayFor),
    )?.color ?? null
  );
}
export function rowColor(
  entry: PortEntry,
  rules: PortColorRule[],
  displayFor?: EntryDisplayResolver,
): PortColor | null {
  return (
    rules.find(
      (rule) => rule.target.kind === "row" && matches(entry, rule, displayFor),
    )?.color ?? null
  );
}

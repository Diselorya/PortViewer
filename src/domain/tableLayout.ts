import type { PortColumnField, PortEntry } from "../types/port";
import type { AppLocale } from "../i18n";
import { COLUMN_WIDTH_LIMITS } from "../types/settings";
import { columnLabel } from "./portPresentation";
import { fieldValue } from "./portQuery";
import type { EntryDisplayResolver } from "./serviceKnowledge";

export function calculateColumnWidths(
  entries: PortEntry[],
  fields: readonly PortColumnField[],
  locale: AppLocale,
  displayFor?: EntryDisplayResolver,
  measure: (text: string) => number = (text) =>
    [...text].reduce(
      (width, char) => width + (char.charCodeAt(0) > 255 ? 13 : 7),
      0,
    ),
): Partial<Record<PortColumnField, number>> {
  const widths: Partial<Record<PortColumnField, number>> = {};
  const count = Math.min(entries.length, 80);
  for (const field of fields) {
    const limits = COLUMN_WIDTH_LIMITS[field] ?? { min: 80, max: 240 };
    let width = measure(columnLabel(field, locale)) + 40;
    for (let index = 0; index < count; index++) {
      const entry = entries[Math.floor((index * entries.length) / count)]!;
      width = Math.max(
        width,
        measure(
          String(fieldValue(entry, field, displayFor) ?? "").slice(0, 256),
        ) + 28,
      );
      if (width >= limits.max) break;
    }
    widths[field] = Math.ceil(
      Math.max(
        limits.min,
        Math.min(limits.max, Number.isFinite(width) ? width : limits.min),
      ),
    );
  }
  return widths;
}

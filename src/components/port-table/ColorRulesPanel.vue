<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app";
import {
  ALL_COLUMN_FIELDS,
  type PortColor,
  type PortColorRule,
} from "../../types/settings";
import type { PortColumnField } from "../../types/port";
import { columnLabel } from "../../domain/portPresentation";
import { useI18n } from "../../i18n";
import FacetConditionEditor from "./FacetConditionEditor.vue";
const store = useAppStore(),
  { locale, t } = useI18n();
const colors: PortColor[] = ["blue", "green", "amber", "red", "purple", "gray"];
const expanded = ref<string | null>(null),
  rules = computed(() => store.settings.colorRules);
function patch(id: string, value: Partial<PortColorRule>) {
  store.updateSettings({
    colorRules: rules.value.map((rule) =>
      rule.id === id ? { ...rule, ...value } : rule,
    ),
  });
}
function add() {
  if (rules.value.length >= 20) return;
  const id =
    globalThis.crypto?.randomUUID?.() ??
    "rule-" + Date.now() + "-" + rules.value.length;
  const filters = Object.fromEntries(
    Object.entries(store.effectiveFacetFilters).map(([field, values]) => [
      field,
      [...(values ?? [])],
    ]),
  );
  if (!Object.values(filters).some((values) => values?.length))
    filters.state = ["Listen"];
  store.updateSettings({
    colorRules: [
      ...rules.value,
      {
        id,
        enabled: true,
        filters,
        mode: store.filterMode,
        fieldModes: { ...store.filterFieldModes },
        target: { kind: "row" },
        color: "blue",
      },
    ],
  });
  expanded.value = id;
}
function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= rules.value.length) return;
  const next = [...rules.value],
    [rule] = next.splice(index, 1);
  next.splice(target, 0, rule!);
  store.updateSettings({ colorRules: next });
}
function targetKind(rule: PortColorRule, value: string) {
  patch(rule.id, {
    target:
      value === "row"
        ? { kind: "row" }
        : {
            kind: "columns",
            fields: [store.settings.visibleColumns[0] ?? "service_name"],
          },
  });
}
function toggleTarget(rule: PortColorRule, field: PortColumnField) {
  if (rule.target.kind !== "columns") return;
  const fields = rule.target.fields.includes(field)
    ? rule.target.fields.filter((item) => item !== field)
    : [...rule.target.fields, field];
  if (fields.length) patch(rule.id, { target: { kind: "columns", fields } });
}
function summary(rule: PortColorRule) {
  const fields = Object.entries(rule.filters).filter(
    ([, values]) => values?.length,
  );
  return fields.length
    ? fields
        .map(
          ([field, values]) =>
            columnLabel(field as PortColumnField, locale.value) +
            " · " +
            values!.length,
        )
        .join(" / ")
    : t("allRows");
}
</script>
<template>
  <div class="color-rules-panel" data-testid="color-rules-panel">
    <p class="workbench-hint">{{ t("colorPriority") }}</p>
    <p v-if="!rules.length" class="workbench-empty">{{ t("noColorRules") }}</p>
    <article
      v-for="(rule, index) in rules"
      :key="rule.id"
      class="color-rule"
      :class="{ 'rule-disabled': !rule.enabled }"
      :data-rule-id="rule.id"
    >
      <div class="color-rule-head">
        <input
          type="checkbox"
          :checked="rule.enabled"
          :aria-label="t('enabled') + ' ' + (index + 1)"
          @change="
            patch(rule.id, {
              enabled: ($event.target as HTMLInputElement).checked,
            })
          "
        />
        <span class="priority-number">{{ index + 1 }}</span>
        <select
          :value="rule.target.kind"
          :aria-label="t('colorTargets')"
          @change="targetKind(rule, ($event.target as HTMLSelectElement).value)"
        >
          <option value="row">{{ t("entireRow") }}</option>
          <option value="columns">{{ t("matchingCells") }}</option>
        </select>
        <button
          class="small-icon"
          :disabled="index === 0"
          :aria-label="t('moveUp')"
          @click="move(index, -1)"
        >
          ↑</button
        ><button
          class="small-icon"
          :disabled="index === rules.length - 1"
          :aria-label="t('moveDown')"
          @click="move(index, 1)"
        >
          ↓
        </button>
        <button
          class="small-icon"
          :aria-label="t('remove')"
          @click="
            store.updateSettings({
              colorRules: rules.filter((item) => item.id !== rule.id),
            })
          "
        >
          ×
        </button>
      </div>
      <div class="color-rule-palette" :aria-label="t('coloring')">
        <button
          v-for="color in colors"
          :key="color"
          class="color-swatch"
          :class="['color-' + color, { chosen: rule.color === color }]"
          :aria-label="t(color)"
          :aria-pressed="rule.color === color"
          @click="patch(rule.id, { color })"
        >
          <span v-if="rule.color === color">✓</span>
        </button>
      </div>
      <fieldset v-if="rule.target.kind === 'columns'" class="color-targets">
        <legend>{{ t("colorTargets") }}</legend>
        <label v-for="field in ALL_COLUMN_FIELDS" :key="field"
          ><input
            type="checkbox"
            :checked="rule.target.fields.includes(field)"
            :disabled="
              rule.target.fields.length === 1 &&
              rule.target.fields.includes(field)
            "
            @change="toggleTarget(rule, field)"
          />{{ columnLabel(field, locale) }}</label
        >
      </fieldset>
      <button
        class="color-condition-toggle"
        :aria-expanded="expanded === rule.id"
        @click="expanded = expanded === rule.id ? null : rule.id"
      >
        <span>{{ t("editConditions") }}</span
        ><small>{{ summary(rule) }}</small
        ><span>{{ expanded === rule.id ? "−" : "+" }}</span>
      </button>
      <FacetConditionEditor
        v-if="expanded === rule.id"
        :model-value="rule.filters"
        :mode="rule.mode ?? 'all'"
        :field-modes="rule.fieldModes ?? {}"
        :entries="store.entries"
        :display-for="store.displayFor"
        @update:model-value="patch(rule.id, { filters: $event })"
        @update:mode="patch(rule.id, { mode: $event })"
        @update:field-modes="patch(rule.id, { fieldModes: $event })"
      />
    </article>
    <button
      class="workbench-add"
      :disabled="rules.length >= 20"
      data-testid="add-color-rule"
      @click="add"
    >
      + {{ t("addColorRule") }}
    </button>
  </div>
</template>

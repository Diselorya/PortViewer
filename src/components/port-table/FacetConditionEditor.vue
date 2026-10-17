<script setup lang="ts">
import { computed, ref, watch } from "vue";
import VirtualScroller from "primevue/virtualscroller";
import {
  FACET_FIELDS,
  facetOptions,
  type FacetField,
  type FacetFilters,
  type ConditionMode,
  type FacetFieldModes,
} from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import type { EntryDisplayResolver } from "../../domain/serviceKnowledge";
import type { PortEntry } from "../../types/port";
import { useI18n } from "../../i18n";

const props = defineProps<{
  modelValue: FacetFilters;
  initialField?: FacetField;
  mode?: ConditionMode;
  fieldModes?: FacetFieldModes;
  entries: PortEntry[];
  displayFor?: EntryDisplayResolver;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: FacetFilters];
  "update:mode": [value: ConditionMode];
  "update:fieldModes": [value: FacetFieldModes];
}>();
const { locale, t } = useI18n();
const field = ref<FacetField>(props.initialField ?? "state"),
  search = ref("");
watch(
  () => props.initialField,
  (value) => {
    if (value) field.value = value;
  },
);
const selected = computed(() => props.modelValue[field.value] ?? []);
const selectedValues = computed(() => new Set(selected.value));
const activeFields = computed(() =>
  FACET_FIELDS.filter((value) => props.modelValue[value]?.length),
);
const options = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return facetOptions(
    props.entries,
    field.value,
    selected.value,
    props.displayFor,
  ).filter(
    (option) =>
      !needle ||
      `${facetValueLabel(field.value, option.value, locale.value)} ${option.value}`
        .toLocaleLowerCase()
        .includes(needle),
  );
});
watch(field, () => {
  search.value = "";
});
function changeFieldMode(target: FacetField, mode: ConditionMode) {
  emit("update:fieldModes", { ...props.fieldModes, [target]: mode });
}
function change(target: FacetField, values: string[]) {
  const filters = { ...props.modelValue };
  if (values.length) filters[target] = values;
  else delete filters[target];
  emit("update:modelValue", filters);
}
function toggle(value: string) {
  change(
    field.value,
    selectedValues.value.has(value)
      ? selected.value.filter((item) => item !== value)
      : [...selected.value, value],
  );
}
</script>

<template>
  <div class="facet-condition-editor" data-testid="facet-values">
    <label class="condition-mode-label">
      {{ t("conditionGroupMode") }}
      <select
        :value="mode ?? 'all'"
        :aria-label="t('conditionGroupMode')"
        data-testid="condition-group-mode"
        @change="
          emit(
            'update:mode',
            ($event.target as HTMLSelectElement).value as ConditionMode,
          )
        "
      >
        <option value="all">{{ t("allConditions") }}</option>
        <option value="any">{{ t("anyCondition") }}</option>
      </select>
    </label>
    <div v-if="activeFields.length" class="condition-list">
      <div v-for="value in activeFields" :key="value" class="condition-row">
        <button
          class="condition-field"
          :class="{ active: field === value }"
          @click="field = value"
        >
          {{ columnLabel(value, locale) }}
        </button>
        <select
          class="condition-operator"
          :value="fieldModes?.[value] ?? 'any'"
          :aria-label="
            t('conditionFieldMode') + ' · ' + columnLabel(value, locale)
          "
          :data-condition-field="value"
          @change="
            changeFieldMode(
              value,
              ($event.target as HTMLSelectElement).value as ConditionMode,
            )
          "
        >
          <option value="any">{{ t("containsAny") }}</option>
          <option value="all">{{ t("containsAll") }}</option>
        </select>
        <button
          class="condition-values"
          @click="field = value"
          :title="
            (modelValue[value] ?? [])
              .map((item) => facetValueLabel(value, item, locale))
              .join('、')
          "
        >
          {{
            (modelValue[value] ?? [])
              .map((item) => facetValueLabel(value, item, locale))
              .join("、")
          }}
        </button>
        <button
          class="small-icon"
          :aria-label="`${t('removeCondition')} · ${columnLabel(value, locale)}`"
          @click="change(value, [])"
        >
          ×
        </button>
      </div>
    </div>
    <div class="condition-picker">
      <div class="condition-picker-head">
        <label
          >{{ t("filterField")
          }}<select
            v-model="field"
            data-testid="facet-field"
            :aria-label="t('filterField')"
          >
            <option v-for="value in FACET_FIELDS" :key="value" :value="value">
              {{ columnLabel(value, locale) }}
            </option>
          </select></label
        >
        <button
          class="text-btn"
          :disabled="!selected.length"
          @click="change(field, [])"
        >
          {{ t("clearField") }}
        </button>
      </div>
      <input
        v-model="search"
        type="search"
        data-testid="facet-value-search"
        :aria-label="t('filterValueSearch')"
        :placeholder="t('filterValueSearch')"
      />
      <VirtualScroller
        v-if="options.length"
        :key="field + ':' + search"
        :items="options"
        :item-size="29"
        :num-tolerated-items="8"
        class="workbench-facet-options"
        :style="{ height: Math.min(options.length * 29, 240) + 'px' }"
      >
        <template #item="{ item: option }">
          <label
            class="facet-option"
            :title="facetValueLabel(field, option.value, locale)"
          >
            <input
              type="checkbox"
              :checked="selectedValues.has(option.value)"
              :value="option.value"
              :data-testid="`facet-option-${option.value}`"
              :data-facet-field="field"
              @change="toggle(option.value)"
            />
            <span>{{ facetValueLabel(field, option.value, locale) }}</span>
            <small>{{ option.count }}</small>
          </label>
        </template>
      </VirtualScroller>
      <p v-else class="workbench-hint">{{ t("noFilterValues") }}</p>
    </div>
  </div>
</template>

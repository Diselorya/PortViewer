<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  FACET_FIELDS,
  facetOptions,
  type FacetField,
  type FacetFilters,
} from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import type { EntryDisplayResolver } from "../../domain/serviceKnowledge";
import type { PortEntry } from "../../types/port";
import { useI18n } from "../../i18n";

const props = defineProps<{
  modelValue: FacetFilters;
  initialField?: FacetField;
  entries: PortEntry[];
  displayFor?: EntryDisplayResolver;
}>();
const emit = defineEmits<{ "update:modelValue": [value: FacetFilters] }>();
const { locale, t } = useI18n();
const field = ref<FacetField>(props.initialField ?? "state"),
  search = ref(""),
  page = ref(0);
const pageSize = 100;
watch(
  () => props.initialField,
  (value) => {
    if (value) field.value = value;
  },
);
const selected = computed(() => props.modelValue[field.value] ?? []);
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
const visibleOptions = computed(() =>
  options.value.slice(page.value * pageSize, (page.value + 1) * pageSize),
);
watch([field, search], () => {
  page.value = 0;
});
watch(field, () => {
  search.value = "";
});
watch(
  () => options.value.length,
  (length) => {
    page.value = Math.min(
      page.value,
      Math.max(0, Math.ceil(length / pageSize) - 1),
    );
  },
);
function change(target: FacetField, values: string[]) {
  const filters = { ...props.modelValue };
  if (values.length) filters[target] = values;
  else delete filters[target];
  emit("update:modelValue", filters);
}
function toggle(value: string) {
  change(
    field.value,
    selected.value.includes(value)
      ? selected.value.filter((item) => item !== value)
      : [...selected.value, value],
  );
}
</script>

<template>
  <div class="facet-condition-editor" data-testid="facet-values">
    <p class="workbench-hint">{{ t("allConditions") }}</p>
    <div v-if="activeFields.length" class="condition-list">
      <div v-for="value in activeFields" :key="value" class="condition-row">
        <button
          class="condition-field"
          :class="{ active: field === value }"
          @click="field = value"
        >
          {{ columnLabel(value, locale) }}
        </button>
        <span class="condition-operator">{{ t("containsAny") }}</span>
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
      <div class="workbench-facet-options">
        <label
          v-for="option in visibleOptions"
          :key="option.value"
          :title="facetValueLabel(field, option.value, locale)"
        >
          <input
            type="checkbox"
            :checked="selected.includes(option.value)"
            :value="option.value"
            :data-testid="`facet-option-${option.value}`"
            :data-facet-field="field"
            @change="toggle(option.value)"
          />
          <span>{{ facetValueLabel(field, option.value, locale) }}</span
          ><small>{{ option.count }}</small>
        </label>
        <p v-if="!visibleOptions.length" class="workbench-hint">
          {{ t("noFilterValues") }}
        </p>
      </div>
      <footer v-if="options.length > pageSize" class="option-pagination">
        <button :disabled="page === 0" @click="page--">
          {{ t("previousPage") }}</button
        ><small>{{
          t("optionPage", {
            start: page * pageSize + 1,
            end: Math.min((page + 1) * pageSize, options.length),
            count: options.length,
          })
        }}</small
        ><button
          :disabled="(page + 1) * pageSize >= options.length"
          @click="page++"
        >
          {{ t("nextPage") }}
        </button>
      </footer>
    </div>
  </div>
</template>

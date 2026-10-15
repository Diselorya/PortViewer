<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { ALL_COLUMN_FIELDS } from "../../types/settings";
import type { PortColumnField } from "../../types/port";
import {
  FACET_FIELDS,
  facetOptions,
  type FacetField,
} from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import { useI18n } from "../../i18n";

const store = useAppStore();
const { locale, t } = useI18n();
const field = ref<FacetField>("state"),
  optionSearch = ref(""),
  optionPage = ref(0);
const optionPageSize = 100;
const selected = computed(() => store.effectiveFacetFilters[field.value] ?? []);
const options = computed(() =>
  facetOptions(store.entries, field.value, selected.value),
);
const matchingOptions = computed(() => {
  const needle = optionSearch.value.trim().toLowerCase();
  return needle
    ? options.value.filter((option) =>
        `${facetValueLabel(field.value, option.value, locale.value)} ${option.value}`
          .toLowerCase()
          .includes(needle),
      )
    : options.value;
});
const visibleOptions = computed(() =>
  matchingOptions.value.slice(
    optionPage.value * optionPageSize,
    (optionPage.value + 1) * optionPageSize,
  ),
);
const activeFilters = computed(() =>
  FACET_FIELDS.flatMap((field) =>
    (store.effectiveFacetFilters[field] ?? []).map((value) => ({
      field,
      value,
    })),
  ),
);
watch([field, optionSearch], () => {
  optionPage.value = 0;
});
watch(field, () => {
  optionSearch.value = "";
});
watch(
  () => matchingOptions.value.length,
  (length) => {
    optionPage.value = Math.min(
      optionPage.value,
      Math.max(0, Math.ceil(length / optionPageSize) - 1),
    );
  },
);

function toggleFacet(target: FacetField, value: string) {
  const values = store.effectiveFacetFilters[target] ?? [];
  store.setFacetFilter(
    target,
    values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value],
  );
}
function changeGroup(event: Event) {
  store.groupBy = ((event.target as HTMLSelectElement).value ||
    null) as FacetField | null;
}
function toggleColumn(field: PortColumnField) {
  const next = [...store.settings.visibleColumns],
    index = next.indexOf(field);
  if (index >= 0 && next.length > 1) next.splice(index, 1);
  else if (index < 0) next.push(field);
  store.updateSettings({ visibleColumns: next });
}
</script>

<template>
  <nav class="querybar" :aria-label="`${t('filterField')} / ${t('export')}`">
    <div class="filter-scroll">
      <div class="filter-group" :aria-label="t('protocol')">
        <button
          v-for="protocol in ['Tcp', 'Udp']"
          :key="protocol"
          class="chip"
          :aria-pressed="store.protocols.includes(protocol)"
          @click="toggleFacet('protocol', protocol)"
        >
          {{ protocol.toUpperCase() }}
        </button>
      </div>
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
    </div>
    <details class="menu facet-menu" data-testid="facet-values">
      <summary
        :aria-label="`${t('filterValues')} · ${columnLabel(field, locale)}`"
      >
        {{
          selected.length
            ? t("selectedValues", { count: selected.length })
            : t("allValues")
        }}
      </summary>
      <div class="menu-panel facet-panel">
        <header>
          <b>{{ columnLabel(field, locale) }}</b
          ><button
            class="text-btn"
            :disabled="!selected.length"
            @click="store.setFacetFilter(field, [])"
          >
            {{ t("clearField") }}
          </button>
        </header>
        <input
          v-model="optionSearch"
          type="search"
          data-testid="facet-value-search"
          :aria-label="t('filterValueSearch')"
          :placeholder="t('filterValueSearch')"
        />
        <div class="facet-options">
          <label
            v-for="option in visibleOptions"
            :key="option.value"
            :title="facetValueLabel(field, option.value, locale)"
            ><input
              type="checkbox"
              :data-testid="`facet-option-${option.value}`"
              :data-facet-field="field"
              :value="option.value"
              :checked="selected.includes(option.value)"
              @change="toggleFacet(field, option.value)"
            /><span>{{ facetValueLabel(field, option.value, locale) }}</span
            ><small>{{ option.count }}</small></label
          >
          <p v-if="!visibleOptions.length">{{ t("noFilterValues") }}</p>
        </div>
        <footer v-if="matchingOptions.length > optionPageSize">
          <button :disabled="optionPage === 0" @click="optionPage--">
            {{ t("previousPage") }}</button
          ><small>{{
            t("optionPage", {
              start: optionPage * optionPageSize + 1,
              end: Math.min(
                (optionPage + 1) * optionPageSize,
                matchingOptions.length,
              ),
              count: matchingOptions.length,
            })
          }}</small
          ><button
            :disabled="
              (optionPage + 1) * optionPageSize >= matchingOptions.length
            "
            @click="optionPage++"
          >
            {{ t("nextPage") }}
          </button>
        </footer>
      </div>
    </details>
    <label class="group-selector"
      >{{ t("groupBy")
      }}<select
        :value="store.groupBy ?? ''"
        data-testid="group-by"
        :aria-label="t('groupBy')"
        @change="changeGroup"
      >
        <option value="">{{ t("noGrouping") }}</option>
        <option v-for="value in FACET_FIELDS" :key="value" :value="value">
          {{ columnLabel(value, locale) }}
        </option>
      </select></label
    >
    <span class="result-count">{{
      t("matches", { count: store.filteredEntries.length })
    }}</span>
    <details class="menu columns-menu">
      <summary>{{ t("columns") }}</summary>
      <div class="menu-panel">
        <label v-for="column in ALL_COLUMN_FIELDS" :key="column"
          ><input
            type="checkbox"
            :checked="store.settings.visibleColumns.includes(column)"
            @change="toggleColumn(column)"
          />{{ columnLabel(column, locale) }}</label
        >
      </div>
    </details>
    <details class="menu">
      <summary>{{ t("export") }}</summary>
      <div class="menu-panel export">
        <button
          :disabled="!store.viewEntries.length"
          @click="store.download('csv')"
        >
          CSV · UTF-8 BOM</button
        ><button
          :disabled="!store.viewEntries.length"
          @click="store.download('json')"
        >
          {{ t("jsonWithMetadata") }}
        </button>
      </div>
    </details>
  </nav>
  <div class="active-filters" data-testid="active-filters">
    <button v-if="store.query" class="chip" @click="store.query = ''">
      {{ store.query }} ×
    </button>
    <button
      v-for="filter in activeFilters"
      :key="`${filter.field}:${filter.value}`"
      class="chip"
      :data-facet-field="filter.field"
      @click="toggleFacet(filter.field, filter.value)"
    >
      {{ columnLabel(filter.field, locale) }}:
      {{ facetValueLabel(filter.field, filter.value, locale) }} ×
    </button>
    <span v-if="!store.activeFilterCount">{{ t("noActiveFilters") }}</span>
    <button
      v-else
      class="text-btn clear-all-filters"
      @click="store.clearFilters"
    >
      {{ t("clearFilters", { count: store.activeFilterCount }) }}
    </button>
  </div>
</template>

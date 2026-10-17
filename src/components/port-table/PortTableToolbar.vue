<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useAppStore } from "../../stores/app";
import { ALL_COLUMN_FIELDS } from "../../types/settings";
import type { PortColumnField, SortSpec } from "../../types/port";
import {
  FACET_FIELDS,
  type FacetField,
  type FacetFilters,
} from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import { useI18n } from "../../i18n";
import FacetConditionEditor from "./FacetConditionEditor.vue";
import ColorRulesPanel from "./ColorRulesPanel.vue";
type Panel = "filters" | "group" | "sort" | "colors" | "fields" | "export";
const emit = defineEmits<{
  "auto-fit": [];
  "group-expansion": [expanded: boolean];
}>();
const store = useAppStore(),
  { locale, t } = useI18n();
const root = ref<HTMLElement | null>(null),
  activePanel = ref<Panel | null>(null),
  panelElement = ref<HTMLElement | null>(null);
const initialFilterField = ref<FacetField>("state");
const newSortField = ref<PortColumnField>("local_port"),
  draggedColumn = ref<number | null>(null);
const panels = computed(() => [
  {
    id: "filters" as const,
    label: t("filters"),
    count: store.activeFilterCount,
  },
  { id: "group" as const, label: t("groupBy"), count: store.groupBy ? 1 : 0 },
  { id: "sort" as const, label: t("sorting"), count: store.sortSpecs.length },
  {
    id: "colors" as const,
    label: t("coloring"),
    count: store.settings.colorRules.filter((rule) => rule.enabled).length,
  },
  { id: "fields" as const, label: t("fields"), count: 0 },
]);
const panelTitle = computed(
  () =>
    panels.value.find((panel) => panel.id === activePanel.value)?.label ??
    t("export"),
);
const activeFilters = computed(() =>
  FACET_FIELDS.flatMap((field) =>
    (store.effectiveFacetFilters[field] ?? []).map((value) => ({
      field,
      value,
    })),
  ),
);
const columns = computed(() => store.settings.columnOrder);
const availableSorts = computed(() =>
  ALL_COLUMN_FIELDS.filter(
    (field) => !store.sortSpecs.some((sort) => sort.field === field),
  ),
);
const scanHost = computed(
  () =>
    store.hostContexts.get("")?.machine_name ??
    store.hostContexts.get("")?.hostname ??
    "",
);
async function togglePanel(panel: Panel) {
  if (activePanel.value === panel) {
    closePanel();
    return;
  }
  activePanel.value = panel;
  await nextTick();
  panelElement.value
    ?.querySelector<HTMLElement>("select, input, button")
    ?.focus();
}
function closePanel(restore = true) {
  const panel = activePanel.value;
  activePanel.value = null;
  if (restore && panel)
    root.value
      ?.querySelector<HTMLElement>('[data-panel-trigger="' + panel + '"]')
      ?.focus();
}
function outside(event: PointerEvent) {
  if (activePanel.value && !root.value?.contains(event.target as Node))
    closePanel(false);
}
function escape(event: KeyboardEvent) {
  if (event.key === "Escape" && activePanel.value) {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  }
}
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
function applyFilters(filters: FacetFilters) {
  for (const field of FACET_FIELDS)
    store.setFacetFilter(field, filters[field] ?? []);
}
function toggleFacet(field: FacetField, value: string) {
  const selected = store.effectiveFacetFilters[field] ?? [];
  store.setFacetFilter(
    field,
    selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value],
  );
}
function updateSort(index: number, patch: Partial<SortSpec>) {
  store.setSortSpecs(
    store.sortSpecs.map((sort, i) =>
      i === index ? { ...sort, ...patch } : sort,
    ),
  );
}
function moveSort(index: number, delta: number) {
  const next = [...store.sortSpecs],
    [item] = next.splice(index, 1);
  next.splice(index + delta, 0, item!);
  store.setSortSpecs(next);
}
watch(
  availableSorts,
  (fields) => {
    if (!fields.includes(newSortField.value) && fields[0])
      newSortField.value = fields[0];
  },
  { immediate: true },
);
function addSort() {
  const field = availableSorts.value.includes(newSortField.value)
    ? newSortField.value
    : availableSorts.value[0];
  if (field) store.setSortSpecs([...store.sortSpecs, { field, order: 1 }]);
}
function toggleColumn(field: PortColumnField) {
  const visible = [...store.settings.visibleColumns],
    index = visible.indexOf(field);
  if (index >= 0 && visible.length > 1) visible.splice(index, 1);
  else if (index < 0) visible.push(field);
  store.updateSettings({ visibleColumns: visible });
}
function moveColumn(index: number, target: number) {
  if (target < 0 || target >= columns.value.length || index === target) return;
  const next = [...columns.value],
    [field] = next.splice(index, 1);
  next.splice(target, 0, field!);
  store.updateSettings({ columnOrder: next });
}
function dropColumn(target: number) {
  if (draggedColumn.value !== null) moveColumn(draggedColumn.value, target);
  draggedColumn.value = null;
}
async function openFilter(field: FacetField) {
  initialFilterField.value = field;
  if (activePanel.value !== "filters") await togglePanel("filters");
}
defineExpose({ openFilter });
function groupChange(event: Event) {
  store.setGroupBy(
    ((event.target as HTMLSelectElement).value || null) as FacetField | null,
  );
}
</script>
<template>
  <div ref="root" class="workbench-toolbar" @keydown="escape">
    <nav
      class="querybar workbench-querybar"
      :aria-label="t('filters') + ' / ' + t('sorting') + ' / ' + t('fields')"
    >
      <div class="workbench-tools">
        <button
          v-for="panel in panels"
          :key="panel.id"
          class="workbench-tool"
          :class="{ active: activePanel === panel.id, configured: panel.count }"
          :data-panel-trigger="panel.id"
          :data-testid="'toolbar-' + panel.id"
          :aria-expanded="activePanel === panel.id"
          :aria-controls="'workbench-panel-' + panel.id"
          @click="togglePanel(panel.id)"
        >
          <span>{{ panel.label }}</span
          ><small v-if="panel.count">{{ panel.count }}</small
          ><span class="tool-chevron">⌄</span>
        </button>
      </div>
      <button
        v-if="scanHost"
        class="scan-host-button"
        :title="t('scanHost') + ': ' + scanHost"
        :disabled="!store.entries.length"
        @click="store.entries[0] && store.openDetail('local', store.entries[0])"
      >
        {{ t("scanHost") }}<b>{{ scanHost }}</b>
      </button>
      <span class="result-count">{{
        t("matches", { count: store.filteredEntries.length })
      }}</span>
      <button
        class="workbench-tool export-tool"
        data-panel-trigger="export"
        :aria-expanded="activePanel === 'export'"
        @click="togglePanel('export')"
      >
        {{ t("export") }} <span class="tool-chevron">⌄</span>
      </button>
    </nav>
    <section
      v-if="activePanel"
      :id="'workbench-panel-' + activePanel"
      ref="panelElement"
      class="workbench-panel"
      :class="'workbench-panel-' + activePanel"
      role="dialog"
      :aria-label="panelTitle"
      :aria-modal="false"
    >
      <header>
        <h2>{{ panelTitle }}</h2>
        <button
          class="small-icon"
          :aria-label="t('close')"
          @click="closePanel()"
        >
          ×
        </button>
      </header>
      <div class="workbench-panel-body">
        <FacetConditionEditor
          v-if="activePanel === 'filters'"
          :initial-field="initialFilterField"
          :model-value="store.effectiveFacetFilters"
          :entries="store.entries"
          :display-for="store.displayFor"
          @update:model-value="applyFilters"
        />
        <div v-else-if="activePanel === 'group'" class="group-panel">
          <label
            >{{ t("groupBy")
            }}<select
              :value="store.groupBy ?? ''"
              data-testid="group-by"
              :aria-label="t('groupBy')"
              @change="groupChange"
            >
              <option value="">{{ t("noGrouping") }}</option>
              <option v-for="field in FACET_FIELDS" :key="field" :value="field">
                {{ columnLabel(field, locale) }}
              </option>
            </select></label
          >
          <p class="workbench-hint">{{ t("groupSetHint") }}</p>
          <div class="panel-button-row">
            <button
              :disabled="!store.groupBy"
              @click="emit('group-expansion', true)"
            >
              {{ t("expandGroups") }}</button
            ><button
              :disabled="!store.groupBy"
              @click="emit('group-expansion', false)"
            >
              {{ t("collapseGroups") }}</button
            ><button
              class="text-btn"
              :disabled="!store.groupBy"
              @click="store.setGroupBy(null)"
            >
              {{ t("noGrouping") }}
            </button>
          </div>
        </div>
        <div v-else-if="activePanel === 'sort'" class="sort-panel">
          <p class="workbench-hint">{{ t("sortPriority") }}</p>
          <p v-if="!store.sortSpecs.length" class="workbench-empty">
            {{ t("noSort") }}
          </p>
          <div
            v-for="(sort, index) in store.sortSpecs"
            :key="sort.field"
            class="sort-rule"
            data-testid="sort-rule"
          >
            <span class="priority-number">{{ index + 1 }}</span
            ><select
              :value="sort.field"
              :aria-label="t('sorting') + ' ' + (index + 1)"
              @change="
                updateSort(index, {
                  field: ($event.target as HTMLSelectElement)
                    .value as PortColumnField,
                })
              "
            >
              <option
                v-for="field in ALL_COLUMN_FIELDS"
                :key="field"
                :value="field"
                :disabled="
                  field !== sort.field &&
                  store.sortSpecs.some((item) => item.field === field)
                "
              >
                {{ columnLabel(field, locale) }}
              </option></select
            ><select
              :value="sort.order"
              :aria-label="t('sorting')"
              @change="
                updateSort(index, {
                  order: Number(($event.target as HTMLSelectElement).value) as
                    1 | -1,
                })
              "
            >
              <option :value="1">{{ t("ascending") }}</option>
              <option :value="-1">{{ t("descending") }}</option></select
            ><button
              class="small-icon"
              :disabled="index === 0"
              :aria-label="t('moveUp')"
              @click="moveSort(index, -1)"
            >
              ↑</button
            ><button
              class="small-icon"
              :disabled="index === store.sortSpecs.length - 1"
              :aria-label="t('moveDown')"
              @click="moveSort(index, 1)"
            >
              ↓</button
            ><button
              class="small-icon"
              :aria-label="t('remove')"
              @click="
                store.setSortSpecs(
                  store.sortSpecs.filter((_, i) => i !== index),
                )
              "
            >
              ×
            </button>
          </div>
          <div v-if="availableSorts.length" class="panel-button-row">
            <select v-model="newSortField" :aria-label="t('addSort')">
              <option
                v-for="field in availableSorts"
                :key="field"
                :value="field"
              >
                {{ columnLabel(field, locale) }}
              </option></select
            ><button data-testid="add-sort" @click="addSort">
              + {{ t("addSort") }}
            </button>
          </div>
          <button
            v-if="store.sortSpecs.length"
            class="text-btn"
            @click="store.setSortSpecs([])"
          >
            {{ t("clear") }}
          </button>
        </div>
        <ColorRulesPanel v-else-if="activePanel === 'colors'" />
        <div v-else-if="activePanel === 'fields'" class="fields-panel">
          <p class="workbench-hint">{{ t("columnOrderHint") }}</p>
          <div class="panel-button-row">
            <button
              :title="t('autoFitHint')"
              data-testid="auto-fit-columns"
              @click="emit('auto-fit')"
            >
              {{ t("autoFit") }}</button
            ><button
              class="text-btn"
              @click="
                store.updateSettings({ columnOrder: [...ALL_COLUMN_FIELDS] })
              "
            >
              {{ t("resetColumns") }}
            </button>
          </div>
          <div
            v-for="(field, index) in columns"
            :key="field"
            class="field-order-row"
            draggable="true"
            :data-column-field="field"
            @dragstart="draggedColumn = index"
            @dragend="draggedColumn = null"
            @dragover.prevent
            @drop.prevent="dropColumn(index)"
          >
            <span class="drag-handle" aria-hidden="true">⋮⋮</span
            ><label
              ><input
                type="checkbox"
                :checked="store.settings.visibleColumns.includes(field)"
                :disabled="
                  store.settings.visibleColumns.length === 1 &&
                  store.settings.visibleColumns.includes(field)
                "
                @change="toggleColumn(field)"
              />{{ columnLabel(field, locale) }}</label
            ><button
              class="small-icon"
              :disabled="index === 0"
              :aria-label="t('moveUp') + ' · ' + columnLabel(field, locale)"
              @click="moveColumn(index, index - 1)"
            >
              ↑</button
            ><button
              class="small-icon"
              :disabled="index === columns.length - 1"
              :aria-label="t('moveDown') + ' · ' + columnLabel(field, locale)"
              @click="moveColumn(index, index + 1)"
            >
              ↓
            </button>
          </div>
        </div>
        <div v-else class="export-panel">
          <button
            :disabled="!store.viewEntries.length"
            @click="
              store.download('csv');
              closePanel();
            "
          >
            CSV · UTF-8 BOM</button
          ><button
            :disabled="!store.viewEntries.length"
            @click="
              store.download('json');
              closePanel();
            "
          >
            {{ t("jsonWithMetadata") }}
          </button>
        </div>
      </div>
    </section>
    <div class="active-filters" data-testid="active-filters">
      <button v-if="store.query" class="chip" @click="store.query = ''">
        {{ store.query }} ×</button
      ><button
        v-for="filter in activeFilters"
        :key="filter.field + ':' + filter.value"
        class="chip"
        :data-facet-field="filter.field"
        @click="toggleFacet(filter.field, filter.value)"
      >
        {{ columnLabel(filter.field, locale) }}:
        {{ facetValueLabel(filter.field, filter.value, locale) }} ×</button
      ><span v-if="!store.activeFilterCount">{{ t("noActiveFilters") }}</span
      ><button
        v-else
        class="text-btn clear-all-filters"
        @click="store.clearFilters"
      >
        {{ t("clearFilters", { count: store.activeFilterCount }) }}
      </button>
    </div>
  </div>
</template>

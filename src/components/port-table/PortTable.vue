<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
} from "vue";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import type { ColumnPassThroughMethodOptions } from "primevue/column";
import type {
  DataTableColumnReorderEvent,
  DataTableSortEvent,
} from "primevue/datatable";
import { useAppStore } from "../../stores/app";
import {
  primaryAttribution,
  serviceManager,
  serviceManagerLabel,
} from "../../domain/attribution";
import { analyzeConnection } from "../../domain/connectionRelation";
import { facetValues, hasRemoteEndpoint } from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import { calculateColumnWidths } from "../../domain/tableLayout";
import { cellColor } from "../../domain/portColor";
import { backendText, processStatusLabel, useI18n } from "../../i18n";
import {
  entryKey,
  type PortColumnField,
  type PortEntry,
  type SortSpec,
} from "../../types/port";
import { FACET_FIELDS, type FacetField } from "../../domain/portFacets";
import EndpointAction from "./EndpointAction.vue";
const emit = defineEmits<{ "filter-field": [field: FacetField] }>();
const store = useAppStore(),
  { locale, state, t } = useI18n();
const tableRoot = ref<HTMLElement | null>(null);
const itemSize = computed(
  () =>
    ({ compact: 40, standard: 52, comfortable: 64 })[store.settings.density],
);
const columns = computed(() =>
  store.settings.columnOrder
    .filter((field) => store.settings.visibleColumns.includes(field))
    .map((field) => ({
      field,
      header: columnLabel(field, locale.value),
      width:
        store.settings.columnWidths[field] ??
        (field === "service_name"
          ? 180
          : field === "service_description"
            ? 240
            : 112),
    })),
);
const tableWidth = computed(() =>
  columns.value.reduce((sum, column) => sum + column.width, 0),
);
interface GroupTableRow {
  __groupRow: true;
  key: string;
  label: string;
  count: number;
  expanded: boolean;
}
type TableRow = PortEntry | GroupTableRow;
function isGroupRow(row: TableRow): row is GroupTableRow {
  return "__groupRow" in row && row.__groupRow === true;
}
const groupExceptions = computed(
  () => new Set(store.settings.groupExpansion.exceptions),
);
const tableEntries = computed<TableRow[]>(() => {
  if (!store.groupBy) return store.viewEntries;
  const rows: TableRow[] = [];
  const defaultExpanded = store.settings.groupExpansion.defaultExpanded;
  const exceptions = groupExceptions.value;
  for (const group of store.entryGroups) {
    const expanded = defaultExpanded !== exceptions.has(group.key);
    const entry = group.entries[0];
    rows.push({
      __groupRow: true,
      key: "group:" + group.key,
      label: entry
        ? facetValues(entry, store.groupBy, store.displayFor)
            .map((value) =>
              facetValueLabel(store.groupBy!, value, locale.value),
            )
            .join(" + ")
        : "",
      count: group.entries.length,
      expanded,
    });
    if (expanded) for (const item of group.entries) rows.push(item);
  }
  return rows;
});
function tableRowKey(row: TableRow) {
  return isGroupRow(row) ? row.key : entryKey(row);
}
function setGroupsExpanded(expanded: boolean) {
  store.updateSettings({
    groupExpansion: { defaultExpanded: expanded, exceptions: [] },
  });
}
function toggleGroup(row: GroupTableRow) {
  const key = row.key.slice("group:".length);
  const exceptions = new Set(groupExceptions.value);
  if (exceptions.has(key)) exceptions.delete(key);
  else exceptions.add(key);
  store.updateSettings({
    groupExpansion: {
      defaultExpanded: store.settings.groupExpansion.defaultExpanded,
      exceptions: [...exceptions],
    },
  });
}
function bodyCellProps(
  options: ColumnPassThroughMethodOptions,
  field: PortColumnField,
) {
  const row = options.parent.props.rowData as TableRow;
  if (!isGroupRow(row)) return { "data-column-field": field };
  return field === columns.value[0]?.field
    ? { colspan: columns.value.length, class: "virtual-group-cell" }
    : { style: { display: "none" }, "aria-hidden": "true" };
}
function onColumnReorder(event: DataTableColumnReorderEvent) {
  const visible = columns.value.map((column) => column.field);
  if (
    event.dragIndex < 0 ||
    event.dropIndex < 0 ||
    event.dragIndex >= visible.length ||
    event.dropIndex >= visible.length ||
    event.dragIndex === event.dropIndex
  )
    return;
  const [field] = visible.splice(event.dragIndex, 1);
  visible.splice(event.dropIndex, 0, field!);
  const visibleSet = new Set(visible);
  let index = 0;
  store.updateSettings({
    columnOrder: store.settings.columnOrder.map((item) =>
      visibleSet.has(item) ? visible[index++]! : item,
    ),
  });
}
function onSort(event: DataTableSortEvent) {
  const raw =
    event.multiSortMeta ??
    (typeof event.sortField === "string" && event.sortOrder
      ? [{ field: event.sortField, order: event.sortOrder }]
      : []);
  store.setSortSpecs(
    raw
      .filter(
        (sort) =>
          typeof sort.field === "string" &&
          (sort.order === 1 || sort.order === -1),
      )
      .map((sort) => ({
        field: sort.field as PortColumnField,
        order: sort.order as 1 | -1,
      })) as SortSpec[],
  );
}
function select(entry: TableRow | null) {
  if (entry && isGroupRow(entry)) return;
  store.selectEntry(entry);
  if (entry) store.openDetail("service", entry);
}
function autoFitColumns(target?: PortColumnField) {
  let measure: ((text: string) => number) | undefined;
  if (typeof CanvasRenderingContext2D !== "undefined") {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      context.font =
        getComputedStyle(tableRoot.value ?? document.body).font ||
        "13px sans-serif";
      measure = (text) => context.measureText(text).width;
    }
  }
  const widths = calculateColumnWidths(
    store.entries,
    target ? [target] : columns.value.map((column) => column.field),
    locale.value,
    store.displayFor,
    measure,
  );
  store.updateSettings({
    columnWidths: { ...store.settings.columnWidths, ...widths },
    columnSizing: "auto",
  });
}
let fittedInitialData = false;
watch(
  () => store.entries.length > 0,
  async (available) => {
    if (available && !fittedInitialData) {
      fittedInitialData = true;
      if (store.settings.columnSizing === "auto") {
        await nextTick();
        autoFitColumns();
      }
    }
  },
  { immediate: true },
);
watch(
  [() => locale.value, () => store.settings.visibleColumns.join("|")],
  async () => {
    if (store.settings.columnSizing === "auto") {
      await nextTick();
      autoFitColumns();
    }
  },
);
function onColumnResize(event: { element: HTMLElement }) {
  const field = event.element.getAttribute(
    "data-column-field",
  ) as PortColumnField | null;
  if (!field) return;
  const width = Math.round(event.element.getBoundingClientRect().width);
  if (width > 0)
    store.updateSettings({
      columnSizing: "manual",
      columnWidths: { ...store.settings.columnWidths, [field]: width },
    });
}
function cellClass(entry: PortEntry, field: PortColumnField) {
  const color = cellColor(
    entry,
    field,
    store.settings.colorRules,
    store.displayFor,
  );
  return color ? "conditional-" + color : "";
}
function actualName(entry: PortEntry) {
  return primaryAttribution(entry)?.name ?? entry.process_name ?? "";
}
function relationTitle(entry: PortEntry) {
  const relation = analyzeConnection(entry);
  return t(relation.titleKey) + " · " + t(relation.evidenceKey);
}
async function copyScanError() {
  try {
    if (store.scanError) await navigator.clipboard.writeText(store.scanError);
    store.notify("info", t("copied"));
  } catch (error) {
    store.notify(
      "error",
      t("copyFailed") +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

const columnMenu = ref<{
  field: PortColumnField;
  left: number;
  top: number;
  anchor: HTMLElement;
} | null>(null);
const columnMenuElement = ref<HTMLElement | null>(null);
async function openColumnMenu(event: MouseEvent, field: PortColumnField) {
  const anchor = event.currentTarget as HTMLElement,
    rect = anchor.getBoundingClientRect();
  columnMenu.value = {
    field,
    left: Math.max(8, Math.min(rect.right - 196, window.innerWidth - 204)),
    top: rect.bottom + 4,
    anchor,
  };
  await nextTick();
  columnMenuElement.value?.querySelector<HTMLElement>("button")?.focus();
}
function closeColumnMenu(restore = true) {
  const anchor = columnMenu.value?.anchor;
  columnMenu.value = null;
  if (restore && anchor?.isConnected) anchor.focus();
}
function columnMenuOutside(event: PointerEvent) {
  if (
    columnMenu.value &&
    !(event.target as Element).closest?.(
      "[data-column-menu], [data-column-menu-trigger]",
    )
  )
    closeColumnMenu(false);
}
function columnMenuResize() {
  closeColumnMenu(false);
}
onMounted(() => {
  document.addEventListener("pointerdown", columnMenuOutside);
  window.addEventListener("resize", columnMenuResize);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", columnMenuOutside);
  window.removeEventListener("resize", columnMenuResize);
});
function columnIsFacet(field: PortColumnField): field is FacetField {
  return (FACET_FIELDS as readonly string[]).includes(field);
}
function sortColumn(field: PortColumnField, order: 1 | -1) {
  store.setSortSpecs([
    { field, order },
    ...store.sortSpecs.filter((sort) => sort.field !== field),
  ]);
  closeColumnMenu();
}
function filterColumn(field: PortColumnField) {
  if (columnIsFacet(field)) emit("filter-field", field);
  closeColumnMenu(false);
}
function groupColumn(field: PortColumnField) {
  if (columnIsFacet(field)) store.setGroupBy(field);
  closeColumnMenu();
}
function hideColumn(field: PortColumnField) {
  if (store.settings.visibleColumns.length > 1)
    store.updateSettings({
      visibleColumns: store.settings.visibleColumns.filter(
        (value) => value !== field,
      ),
    });
  closeColumnMenu(false);
}

defineExpose({ autoFitColumns, setGroupsExpanded });
</script>
<template>
  <div
    ref="tableRoot"
    class="port-table-wrap workbench-table-wrap"
    data-testid="port-table"
    :style="{ '--workload-row': itemSize + 'px' }"
  >
    <div
      v-if="!store.hasScanned && store.isScanning"
      class="skeleton-table"
      aria-busy="true"
      :aria-label="t('loading')"
    >
      <div class="skeleton-head" />
      <div v-for="n in 10" :key="n" class="skeleton-row">
        <i v-for="c in 6" :key="c" />
      </div>
      <p>{{ t("loading") }}</p>
    </div>
    <div v-else-if="!store.hasScanned" class="center-state">
      <b>{{ t("notScanned") }}</b>
      <p>{{ t("notScannedHint") }}</p>
      <button class="primary-btn" @click="store.refresh">
        {{ t("startScan") }}
      </button>
    </div>
    <div
      v-else-if="store.scanError && !store.entries.length"
      class="center-state error-state"
      role="alert"
    >
      <b>{{ t("scanFailed") }}</b>
      <p>{{ t("scanFailedHint") }}</p>
      <code>{{ store.scanError }}</code>
      <div>
        <button class="primary-btn" @click="store.refresh">
          {{ t("scanAgain") }}</button
        ><button @click="copyScanError">{{ t("copyDiagnostics") }}</button>
      </div>
    </div>
    <DataTable
      v-else
      :key="
        (store.groupBy ?? 'flat') +
        ':' +
        itemSize +
        ':' +
        columns.map((column) => column.field).join('|')
      "
      :value="tableEntries"
      :selection="store.selectedEntry"
      :data-key="tableRowKey"
      :row-class="
        (row: TableRow) => (isGroupRow(row) ? 'virtual-group-row' : undefined)
      "
      selection-mode="single"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="{ itemSize, delay: 50, numToleratedItems: 20 }"
      lazy
      :multi-sort-meta="store.sortSpecs"
      sort-mode="multiple"
      removable-sort
      size="small"
      reorderable-columns
      resizable-columns
      column-resize-mode="expand"
      class="port-table connection-table workbench-table"
      :table-style="{
        width: tableWidth + 'px',
        minWidth: tableWidth + 'px',
        tableLayout: 'fixed',
      }"
      @update:selection="select($event as TableRow)"
      @sort="onSort"
      @column-reorder="onColumnReorder"
      @column-resize-end="onColumnResize"
    >
      <Column
        v-for="column in columns"
        :key="column.field"
        :field="column.field"
        :header="column.header"
        sortable
        :style="{
          width: column.width + 'px',
          minWidth: column.width + 'px',
          maxWidth: column.width + 'px',
        }"
        :pt="{
          headerCell: { 'data-column-field': column.field },
          bodyCell: (options) => bodyCellProps(options, column.field),
        }"
      >
        <template #header
          ><button
            class="column-menu-trigger"
            data-column-menu-trigger
            :aria-label="t('fieldActions') + ' · ' + column.header"
            aria-haspopup="menu"
            @click.stop="openColumnMenu($event, column.field)"
            @keydown.stop
          >
            ⋮
          </button></template
        >
        <template #sorticon="{ sorted, sortOrder }">
          <span v-if="sorted" class="column-sort-arrow" aria-hidden="true">{{
            sortOrder === 1 ? "↑" : "↓"
          }}</span>
        </template>
        <template #body="{ data }: { data: TableRow }">
          <button
            v-if="isGroupRow(data) && column.field === columns[0]?.field"
            class="port-group-header"
            data-testid="port-group-header"
            :data-group-key="data.key.slice('group:'.length)"
            :aria-expanded="data.expanded"
            :aria-label="
              (data.expanded ? t('groupCollapse') : t('groupExpand')) +
              ' · ' +
              data.label
            "
            @click.stop="toggleGroup(data)"
            @keydown.stop
          >
            <span class="group-toggle-arrow" aria-hidden="true">{{
              data.expanded ? "⌄" : "›"
            }}</span>
            <b>{{ data.label }}</b>
            <small>{{ t("groupCount", { count: data.count }) }}</small>
          </button>
          <div
            v-else-if="!isGroupRow(data)"
            class="port-cell"
            :class="cellClass(data, column.field)"
          >
            <span
              v-if="column.field === 'protocol'"
              class="protocol"
              :class="data.protocol.toLowerCase()"
              >{{ data.protocol.toUpperCase() }}</span
            >
            <span v-else-if="column.field === 'ip_version'" class="mono">{{
              data.ip_version === "V4" ? "IPv4" : "IPv6"
            }}</span>
            <button
              v-else-if="column.field === 'service_name'"
              class="service-name-action cell-action"
              :title="t('serviceDetails') + ' · ' + actualName(data)"
              @click.stop="store.openDetail('service', data)"
              @keydown.stop
            >
              <b>{{ store.displayFor(data).serviceName }}</b
              ><small
                v-if="
                  actualName(data) &&
                  actualName(data) !== store.displayFor(data).serviceName
                "
                >{{ backendText(locale, actualName(data)) }}</small
              >
            </button>
            <span
              v-else-if="column.field === 'service_description'"
              class="service-description"
              :title="store.displayFor(data).serviceDescription"
              >{{
                store.displayFor(data).serviceDescription ||
                t("purposeUnavailable")
              }}</span
            >
            <button
              v-else-if="column.field === 'local_host'"
              class="cell-action host-action"
              :title="t('machineDetails')"
              @click.stop="store.openDetail('local', data)"
              @keydown.stop
            >
              {{ store.displayFor(data).localHost || t("unavailable") }}
            </button>
            <button
              v-else-if="
                column.field === 'remote_host' && hasRemoteEndpoint(data)
              "
              class="cell-action host-action"
              :title="t('machineDetails') + ' · ' + t('reverseDnsHint')"
              @click.stop="store.openDetail('remote', data)"
              @keydown.stop
            >
              {{ store.displayFor(data).remoteHost || "—" }}
            </button>
            <span v-else-if="column.field === 'remote_host'">—</span>
            <button
              v-else-if="column.field === 'local_address'"
              class="cell-action endpoint-cell mono"
              :title="t('machineDetails') + ' · ' + data.local_address"
              @click.stop="store.openDetail('local', data)"
              @keydown.stop
            >
              {{ data.local_address }}
            </button>
            <EndpointAction
              v-else-if="column.field === 'local_port'"
              :entry="data"
            />
            <button
              v-else-if="
                column.field === 'remote_address' && hasRemoteEndpoint(data)
              "
              class="cell-action endpoint-cell mono"
              :title="t('machineDetails') + ' · ' + data.remote_address"
              @click.stop="store.openDetail('remote', data)"
              @keydown.stop
            >
              {{ data.remote_address }}
            </button>
            <span
              v-else-if="column.field === 'remote_address'"
              :title="t('noFixedPeer')"
              >—</span
            >
            <EndpointAction
              v-else-if="column.field === 'remote_port'"
              :entry="data"
              side="remote"
            />
            <span
              v-else-if="column.field === 'role'"
              class="direction-cell"
              :class="'role-' + analyzeConnection(data).role"
              :title="relationTitle(data)"
              ><b class="direction-arrow">{{ analyzeConnection(data).arrow }}</b
              ><strong>{{ t(analyzeConnection(data).titleKey) }}</strong></span
            >
            <span
              v-else-if="column.field === 'state'"
              class="state-pill"
              :class="
                'state-' +
                (data.protocol === 'Tcp'
                  ? (data.state ?? 'unknown').toLowerCase()
                  : 'na')
              "
              :data-state="
                data.protocol === 'Tcp' ? data.state : 'not-applicable'
              "
              >{{
                data.protocol === "Tcp" ? state(data.state) : t("notApplicable")
              }}</span
            >
            <span
              v-else-if="column.field === 'service_manager'"
              class="manager-cell"
              >{{ serviceManagerLabel(serviceManager(data), locale) }}</span
            >
            <span
              v-else-if="
                column.field === 'attribution_kind' ||
                column.field === 'attribution_confidence'
              "
              class="cell-truncate"
              >{{
                facetValues(data, column.field, store.displayFor)
                  .map((value) =>
                    facetValueLabel(
                      column.field as
                        "attribution_kind" | "attribution_confidence",
                      value,
                      locale,
                    ),
                  )
                  .join(" + ")
              }}</span
            >
            <span
              v-else-if="column.field === 'process_status'"
              class="process-status"
              :class="'process-' + data.process_status.toLowerCase()"
              >{{ processStatusLabel(locale, data.process_status) }}</span
            >
            <button
              v-else-if="column.field === 'attribution'"
              class="cell-action owner-cell"
              @click.stop="store.openDetail('service', data)"
              @keydown.stop
            >
              {{ backendText(locale, actualName(data)) || t("unavailable") }}
            </button>
            <span
              v-else
              class="mono cell-truncate"
              :title="String(data[column.field as keyof PortEntry] ?? '')"
              >{{ data[column.field as keyof PortEntry] ?? "—" }}</span
            >
          </div>
        </template>
      </Column>
      <template #empty
        ><div class="center-state">
          <b>{{ store.entries.length ? t("noMatches") : t("noEndpoints") }}</b>
          <p v-if="store.entries.length">
            {{ t("noMatchesHint", { query: store.query }) }}
          </p>
          <button v-if="store.activeFilterCount" @click="store.clearFilters">
            {{ t("clearSearchFilters") }}</button
          ><button v-else @click="store.refresh">{{ t("scanAgain") }}</button>
        </div></template
      >
    </DataTable>
    <div
      v-if="columnMenu"
      ref="columnMenuElement"
      class="column-action-menu"
      data-column-menu
      role="menu"
      :aria-label="columnLabel(columnMenu.field, locale)"
      :style="{ left: columnMenu.left + 'px', top: columnMenu.top + 'px' }"
      @keydown.escape.stop.prevent="closeColumnMenu()"
    >
      <b>{{ columnLabel(columnMenu.field, locale) }}</b>
      <button role="menuitem" @click="sortColumn(columnMenu.field, 1)">
        {{ t("ascending") }}
      </button>
      <button role="menuitem" @click="sortColumn(columnMenu.field, -1)">
        {{ t("descending") }}
      </button>
      <button
        v-if="columnIsFacet(columnMenu.field)"
        role="menuitem"
        @click="filterColumn(columnMenu.field)"
      >
        {{ t("filterField") }}
      </button>
      <button
        v-if="columnIsFacet(columnMenu.field)"
        role="menuitem"
        @click="groupColumn(columnMenu.field)"
      >
        {{ t("groupBy") }}
      </button>
      <button
        role="menuitem"
        @click="
          autoFitColumns(columnMenu.field);
          closeColumnMenu();
        "
      >
        {{ t("autoFit") }}
      </button>
      <button
        role="menuitem"
        :disabled="store.settings.visibleColumns.length === 1"
        @click="hideColumn(columnMenu.field)"
      >
        {{ t("hideField") }}
      </button>
    </div>
  </div>
</template>

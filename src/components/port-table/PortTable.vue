<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import type {
  DataTablePageEvent,
  DataTableSortEvent,
} from "primevue/datatable";
import { useAppStore } from "../../stores/app";
import {
  attributionContext,
  attributionDetails,
  kindLabel,
  primaryAttribution,
  serviceManager,
  serviceManagerLabel,
} from "../../domain/attribution";
import { analyzeConnection } from "../../domain/connectionRelation";
import {
  facetGroupKey,
  facetValues,
  hasRemoteEndpoint,
} from "../../domain/portFacets";
import { columnLabel, facetValueLabel } from "../../domain/portPresentation";
import { ALL_COLUMN_FIELDS } from "../../types/settings";
import { backendText, processStatusLabel, useI18n } from "../../i18n";
import {
  entryKey,
  type PortColumnField,
  type PortEntry,
  type SortSpec,
} from "../../types/port";

const store = useAppStore();
const { locale, state, t } = useI18n();
const defs = computed<Array<{ field: PortColumnField; header: string }>>(() =>
  ALL_COLUMN_FIELDS.map((field) => ({
    field,
    header: columnLabel(field, locale.value),
  })),
);
const columns = computed(() =>
  defs.value.filter((d) => store.settings.visibleColumns.includes(d.field)),
);
const itemSize = computed(
  () =>
    ({ compact: 64, standard: 72, comfortable: 80 })[store.settings.density],
);
const first = ref(0),
  rows = ref(100);
type TableEntry = PortEntry & { __groupKey?: string };
const tableEntries = computed<TableEntry[]>(() =>
  store.groupBy
    ? store.viewEntries
        .slice(first.value, first.value + rows.value)
        .map((entry) => ({
          ...entry,
          __groupKey: facetGroupKey(entry, store.groupBy!),
        }))
    : store.viewEntries,
);
const groupCounts = computed(
  () =>
    new Map(
      store.entryGroups.map((group) => [group.key, group.entries.length]),
    ),
);
const groupKey = (entry: PortEntry) =>
  store.groupBy ? facetGroupKey(entry, store.groupBy) : "";
function groupLabel(entry: PortEntry) {
  return store.groupBy
    ? facetValues(entry, store.groupBy)
        .map((value) => facetValueLabel(store.groupBy!, value, locale.value))
        .join(" + ")
    : "";
}
function onPage(event: DataTablePageEvent) {
  first.value = event.first;
  rows.value = event.rows;
}
watch(
  () => [
    store.groupBy,
    store.query,
    JSON.stringify(store.effectiveFacetFilters),
    JSON.stringify(store.sort),
  ],
  () => {
    first.value = 0;
  },
);
watch(
  () => store.viewEntries.length,
  (length) => {
    if (first.value >= length)
      first.value =
        Math.max(0, Math.ceil(length / rows.value) - 1) * rows.value;
  },
);

function owner(entry: PortEntry) {
  const attribution = primaryAttribution(entry);
  if (attribution)
    return {
      primary: backendText(locale.value, attribution.name),
      description: attribution.description
        ? backendText(locale.value, attribution.description)
        : `${kindLabel(attribution.kind, locale.value)} · ${t("purposeUnavailable")}`,
      secondary: [
        attributionContext(attribution, (value) =>
          backendText(locale.value, value),
        ) ||
          entry.process_path ||
          t("locationUnavailable"),
        entry.process_name,
        entry.pid > 0 ? `PID ${entry.pid}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      title: attributionDetails(attribution, locale.value, (value) =>
        backendText(locale.value, value),
      ),
      limited: false,
    };
  const status = processStatusLabel(
    locale.value,
    entry.process_status,
    entry.process_status_message,
  );
  const unknownPid = entry.pid === 0 && entry.process_status !== "System";
  return {
    primary: entry.process_name ?? (unknownPid ? t("unknownOwner") : status),
    description: unknownPid ? t("attributionLimited") : t("processOnly"),
    secondary: entry.process_path ?? status,
    title: entry.process_status_message ?? status,
    limited:
      unknownPid ||
      ["AccessDenied", "Unavailable"].includes(entry.process_status),
  };
}
function relationConfidence(entry: PortEntry) {
  const value = analyzeConnection(entry).confidence;
  return t(value === "exact" ? "certain" : value);
}

function onSort(event: DataTableSortEvent) {
  const raw =
    event.multiSortMeta ??
    (typeof event.sortField === "string" && event.sortOrder
      ? [{ field: event.sortField, order: event.sortOrder }]
      : []);
  store.sort = raw
    .filter(
      (s) => typeof s.field === "string" && (s.order === 1 || s.order === -1),
    )
    .map((s) => ({
      field: s.field as PortColumnField,
      order: s.order as 1 | -1,
    })) as SortSpec[];
}

async function copyScanError() {
  try {
    if (store.scanError) await navigator.clipboard.writeText(store.scanError);
    store.notify(
      "info",
      locale.value === "zh-CN" ? "诊断信息已复制" : "Diagnostics copied",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    store.notify(
      "error",
      locale.value === "zh-CN"
        ? `复制诊断信息失败：${detail}`
        : `Failed to copy diagnostics: ${detail}`,
    );
  }
}
</script>

<template>
  <div
    class="port-table-wrap"
    data-testid="port-table"
    :style="{ '--workload-row': `${itemSize}px` }"
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
        ><button @click="copyScanError()">{{ t("copyDiagnostics") }}</button>
      </div>
    </div>
    <DataTable
      v-else
      :key="store.groupBy ? `grouped:${store.groupBy}` : `flat:${itemSize}`"
      :value="tableEntries"
      :selection="store.selectedEntry"
      :data-key="entryKey"
      selection-mode="single"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="
        store.groupBy
          ? undefined
          : { itemSize, delay: 50, numToleratedItems: 20 }
      "
      lazy
      :paginator="Boolean(store.groupBy)"
      :first="first"
      :rows="rows"
      :rows-per-page-options="[50, 100, 200]"
      :total-records="store.viewEntries.length"
      :row-group-mode="store.groupBy ? 'subheader' : undefined"
      :group-rows-by="store.groupBy ? '__groupKey' : undefined"
      :multi-sort-meta="store.sort"
      :pt="{ rowGroupHeaderCell: { colspan: columns.length } }"
      sort-mode="multiple"
      removable-sort
      size="small"
      class="port-table connection-table"
      table-style="min-width: 1400px"
      @update:selection="store.selectEntry($event as PortEntry)"
      @sort="onSort"
      @page="onPage"
    >
      <template #header v-if="store.groupBy"
        ><div class="group-view-hint" :title="t('groupSetHint')">
          {{ columnLabel(store.groupBy, locale) }} ·
          {{ store.entryGroups.length }} {{ t("groupBy") }} ·
          {{ t("groupPageHint", { count: store.viewEntries.length }) }}
        </div></template
      >
      <template #groupheader="{ data }: { data: PortEntry }"
        ><span
          class="port-group-header"
          data-testid="port-group-header"
          :data-group-key="groupKey(data)"
          ><b>{{ groupLabel(data) }}</b
          ><small>{{
            t("groupCount", { count: groupCounts.get(groupKey(data)) ?? 0 })
          }}</small></span
        ></template
      >
      <Column
        v-for="column in columns"
        :key="column.field"
        :field="column.field"
        :header="column.header"
        sortable
      >
        <template #body="{ data }: { data: PortEntry }">
          <span
            v-if="column.field === 'protocol'"
            class="protocol"
            :class="data.protocol.toLowerCase()"
            >{{ data.protocol.toUpperCase() }}</span
          >
          <span v-else-if="column.field === 'ip_version'" class="mono">{{
            data.ip_version === "V4" ? "IPv4" : "IPv6"
          }}</span>
          <span
            v-else-if="column.field === 'local_address'"
            class="endpoint-cell"
            ><b class="mono">{{ data.local_address }}</b></span
          >
          <span
            v-else-if="column.field === 'local_port'"
            class="mono port-number"
            >{{ data.local_port }}</span
          >
          <span
            v-else-if="column.field === 'role'"
            class="direction-cell"
            :class="`role-${analyzeConnection(data).role}`"
          >
            <b class="direction-arrow">{{ analyzeConnection(data).arrow }}</b
            ><span
              ><strong>{{ t(analyzeConnection(data).titleKey) }}</strong
              ><small
                >{{ relationConfidence(data) }} ·
                {{ t(analyzeConnection(data).evidenceKey) }}</small
              ></span
            >
          </span>
          <span
            v-else-if="column.field === 'remote_address'"
            class="endpoint-cell"
            ><b class="mono">{{
              hasRemoteEndpoint(data) ? data.remote_address : "—"
            }}</b
            ><small v-if="!hasRemoteEndpoint(data)">{{
              t("noFixedPeer")
            }}</small></span
          >
          <span
            v-else-if="column.field === 'remote_port'"
            class="mono port-number"
            >{{ hasRemoteEndpoint(data) ? data.remote_port : "—" }}</span
          >
          <span v-else-if="column.field === 'state'" class="state-pill">{{
            data.protocol === "Tcp" ? state(data.state) : t("notApplicable")
          }}</span>
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
            >{{
              facetValues(data, column.field)
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
          <span v-else-if="column.field === 'process_status'">{{
            processStatusLabel(locale, data.process_status)
          }}</span>
          <span
            v-else-if="column.field === 'attribution'"
            class="owner-cell"
            :class="{ limited: owner(data).limited }"
            :title="owner(data).title"
            ><b>{{ owner(data).primary }}</b
            ><small class="owner-purpose">{{ owner(data).description }}</small
            ><small>{{ owner(data).secondary }}</small></span
          >
          <span v-else class="mono" :title="String(data[column.field] ?? '')">{{
            data[column.field] ?? "—"
          }}</span>
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
  </div>
</template>

<style scoped>
:deep(.connection-table .p-datatable-tbody > tr),
:deep(.connection-table .p-datatable-tbody > tr > td) {
  height: var(--workload-row);
}
:deep(.connection-table .p-datatable-tbody > tr.p-datatable-row-group-header),
:deep(
  .connection-table .p-datatable-tbody > tr.p-datatable-row-group-header > td
) {
  height: 34px;
  background: var(--subtle);
}
:deep(.owner-cell) {
  max-width: 420px;
}
:deep(.owner-cell .owner-purpose) {
  color: var(--text);
}
</style>

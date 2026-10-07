<script setup lang="ts">
import { computed } from "vue";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import type { DataTableSortEvent } from "primevue/datatable";
import { useAppStore } from "../../stores/app";
import { primaryAttribution } from "../../domain/attribution";
import {
  analyzeConnection,
  localEndpoint,
  remoteEndpoint,
} from "../../domain/connectionRelation";
import { backendText, processStatusLabel, useI18n } from "../../i18n";
import type { PortColumnField, PortEntry, SortSpec } from "../../types/port";

const store = useAppStore();
const { locale, state, t } = useI18n();
const defs = computed<Array<{ field: PortColumnField; header: string }>>(() => [
  { field: "protocol", header: t("protocol") },
  { field: "local_address", header: t("localEndpoint") },
  { field: "local_port", header: t("directionRole") },
  { field: "remote_address", header: t("peer") },
  { field: "state", header: t("state") },
  { field: "attribution", header: t("processOwner") },
]);
const columns = computed(() =>
  defs.value.filter((d) => store.settings.visibleColumns.includes(d.field)),
);
const itemSize = computed(
  () =>
    ({ compact: 48, standard: 56, comfortable: 64 })[store.settings.density],
);

function owner(entry: PortEntry) {
  const attribution = primaryAttribution(entry);
  if (attribution)
    return {
      primary: backendText(locale.value, attribution.name),
      secondary: entry.process_name ?? `PID ${entry.pid}`,
      limited: false,
    };
  const status = processStatusLabel(
    locale.value,
    entry.process_status,
    entry.process_status_message,
  );
  return {
    primary: entry.process_name ?? status,
    secondary: entry.process_name ? t("processOnly") : status,
    limited: entry.process_status === "AccessDenied",
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
  <div class="port-table-wrap">
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
      :value="store.viewEntries"
      :selection="store.selectedEntry"
      selection-mode="single"
      scrollable
      scroll-height="flex"
      :virtual-scroller-options="{ itemSize, delay: 50, numToleratedItems: 20 }"
      sort-mode="multiple"
      removable-sort
      size="small"
      class="port-table connection-table"
      table-style="min-width: 980px"
      @update:selection="store.selectEntry($event as PortEntry)"
      @sort="onSort"
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
          <span
            v-else-if="column.field === 'local_address'"
            class="endpoint-cell"
            ><b class="mono">{{ localEndpoint(data) }}</b
            ><small>{{ t("local") }}</small></span
          >
          <span
            v-else-if="column.field === 'local_port'"
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
            ><b class="mono">{{ remoteEndpoint(data) }}</b
            ><small>{{
              data.remote_address ? t("remote") : t("noFixedPeer")
            }}</small></span
          >
          <span v-else-if="column.field === 'state'" class="state-pill">{{
            data.protocol === "Tcp" ? state(data.state) : "UDP"
          }}</span>
          <span
            v-else
            class="owner-cell"
            :class="{ limited: owner(data).limited }"
            ><b>{{ owner(data).primary }}</b
            ><small>{{ owner(data).secondary }}</small></span
          >
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

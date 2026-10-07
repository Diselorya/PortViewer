<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app";
import type { PortColumnField } from "../../types/port";
import { useI18n } from "../../i18n";
const store = useAppStore(),
  protocols = ["Tcp", "Udp"],
  states = [
    "Listen",
    "Established",
    "TimeWait",
    "CloseWait",
    "SynSent",
    "SynRcvd",
    "FinWait1",
    "FinWait2",
    "Closed",
    "Closing",
    "LastAck",
    "DeleteTcb",
    "Unknown",
  ],
  availableColumns: Array<{
    field: PortColumnField;
    key:
      | "protocol"
      | "localEndpoint"
      | "directionRole"
      | "peer"
      | "state"
      | "processOwner";
  }> = [
    { field: "protocol", key: "protocol" },
    { field: "local_address", key: "localEndpoint" },
    { field: "local_port", key: "directionRole" },
    { field: "remote_address", key: "peer" },
    { field: "state", key: "state" },
    { field: "attribution", key: "processOwner" },
  ];
const { state: stateText, t } = useI18n();
const hasFilters = computed(() => store.activeFilterCount > 0);
function toggle(target: string[], value: string) {
  const i = target.indexOf(value);
  i < 0 ? target.push(value) : target.splice(i, 1);
}
function changeState(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  store.states = value ? [value] : [];
}
function toggleColumn(field: PortColumnField) {
  const next = [...store.settings.visibleColumns],
    i = next.indexOf(field);
  if (i >= 0 && next.length > 1) next.splice(i, 1);
  else if (i < 0) next.push(field);
  store.updateSettings({ visibleColumns: next });
}
</script>
<template>
  <nav class="querybar" :aria-label="`${t('state')} / ${t('export')}`">
    <div class="filter-scroll">
      <div class="filter-group" aria-label="协议筛选">
        <button
          v-for="p in protocols"
          :key="p"
          class="chip"
          :aria-pressed="store.protocols.includes(p)"
          @click="toggle(store.protocols, p)"
        >
          {{ p.toUpperCase() }}
        </button>
      </div>
      <div class="separator"></div>
      <label
        >{{ t("state")
        }}<select :value="store.states[0] ?? ''" @change="changeState">
          <option value="">{{ t("allStates") }}</option>
          <option v-for="s in states" :key="s" :value="s">
            {{ stateText(s as any) }}
          </option>
        </select></label
      >
      <button v-if="hasFilters" class="text-btn" @click="store.clearFilters">
        {{ t("clearFilters", { count: store.activeFilterCount }) }}
      </button>
    </div>
    <span class="result-count">{{
      t("matches", { count: store.filteredEntries.length })
    }}</span>
    <details class="menu">
      <summary>{{ t("columns") }}</summary>
      <div class="menu-panel">
        <label v-for="c in availableColumns" :key="c.field"
          ><input
            type="checkbox"
            :checked="store.settings.visibleColumns.includes(c.field)"
            @change="toggleColumn(c.field)"
          />{{ t(c.key) }}</label
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
</template>

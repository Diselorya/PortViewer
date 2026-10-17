<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app";
import { endpointLink } from "../../domain/endpointLink";
import { hasRemoteEndpoint } from "../../domain/portFacets";
import type { PortEntry } from "../../types/port";
import { useI18n } from "../../i18n";
import { openExternalUrl } from "../../services/backend";
const props = withDefaults(
  defineProps<{ entry: PortEntry; side?: "local" | "remote" }>(),
  { side: "local" },
);
const store = useAppStore(),
  { t } = useI18n();
const available = computed(
  () => props.side === "local" || hasRemoteEndpoint(props.entry),
);
const port = computed(() =>
  props.side === "local" ? props.entry.local_port : props.entry.remote_port,
);
const link = computed(() =>
  endpointLink(props.entry, props.side, {
    runtime: store.webReadOnly ? "web" : "desktop",
    scanHost: store.webReadOnly ? window.location.hostname : undefined,
    browserHost: window.location.hostname,
  }),
);
async function visit(event: MouseEvent) {
  if (
    (store.webReadOnly &&
      (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) ||
    !link.value.url
  )
    return;
  event.preventDefault();
  try {
    await openExternalUrl(link.value.url);
  } catch (error) {
    store.notify(
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
</script>
<template>
  <span v-if="!available" class="mono">—</span>
  <a
    v-else-if="
      link.url && (link.kind === 'web' || link.kind === 'possible-web')
    "
    class="endpoint-action mono port-number"
    :class="{ 'possible-web-link': link.kind === 'possible-web' }"
    :href="link.url"
    target="_blank"
    rel="noopener noreferrer"
    :title="
      (link.kind === 'possible-web' ? t('possibleWeb') : t('openWeb')) +
      ' · ' +
      link.url +
      ' · ' +
      link.reason
    "
    @click.stop="visit"
    @keydown.stop
    >{{ port
    }}<small aria-hidden="true">{{
      link.kind === "possible-web" ? "↗?" : "↗"
    }}</small></a
  >
  <button
    v-else
    class="endpoint-action mono port-number"
    :title="t('endpointDetails') + ' · ' + link.reason"
    @click.stop="store.openDetail('endpoint', entry)"
    @keydown.stop
  >
    {{ port }}
  </button>
</template>

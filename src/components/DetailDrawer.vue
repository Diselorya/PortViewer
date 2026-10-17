<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Dialog from "primevue/dialog";
import VirtualScroller from "primevue/virtualscroller";
import { useAppStore } from "../stores/app";
import {
  attributionDetails,
  confidenceLabel,
  kindLabel,
  serviceManager,
  serviceManagerLabel,
} from "../domain/attribution";
import {
  analyzeConnection,
  localEndpoint,
  relationSentence,
  remoteEndpoint,
} from "../domain/connectionRelation";
import { endpointLink } from "../domain/endpointLink";
import { hasRemoteEndpoint } from "../domain/portFacets";
import {
  backendText,
  processStatusLabel,
  useI18n,
  type TranslationKey,
} from "../i18n";
import { entryKey } from "../types/port";
import type { ServiceProfile } from "../types/knowledge";
import { openExternalUrl } from "../services/backend";
const store = useAppStore(),
  { locale, state, t } = useI18n();
const entry = computed(() => store.detailEntry);
watch(entry, (current, previous) => {
  if (!current && previous) store.closeDetail();
});
const kind = computed(() => store.selectedDetail?.kind ?? "service");
const display = computed(() =>
  entry.value ? store.displayFor(entry.value) : null,
);
const workloadPurpose = computed(
  () =>
    display.value?.profiles.find(
      (profile) => profile.component_role === "workload" && profile.summary,
    )?.summary ??
    entry.value?.attributions.find(
      (item) =>
        [
          "NodeApplication",
          "PythonApplication",
          "DockerContainer",
          "WindowsService",
          "NssmService",
          "SystemdService",
          "NginxSite",
          "IisSite",
        ].includes(item.kind) && item.description,
    )?.description ??
    "",
);
const tab = ref<"overview" | "evidence" | "connections">("overview"),
  tabBar = ref<HTMLElement | null>(null);
const tabs = [
  { id: "overview" as const, label: "overview" as const },
  { id: "evidence" as const, label: "evidencePaths" as const },
  { id: "connections" as const, label: "relatedConnections" as const },
];
const host = computed(() =>
  !entry.value
    ? null
    : kind.value === "remote"
      ? store.hostContexts.get(entry.value.remote_address ?? "")
      : (store.hostContexts.get("") ??
        store.hostContexts.get(entry.value.local_address)),
);
const title = computed(() =>
  kind.value === "service"
    ? (display.value?.serviceName ?? t("serviceDetails"))
    : kind.value === "endpoint"
      ? t("endpointDetails")
      : (kind.value === "remote"
          ? display.value?.remoteHost
          : display.value?.localHost) || t("machineDetails"),
);
const relatedEntries = computed(() => {
  const current = entry.value;
  if (!current) return [];
  if (kind.value === "remote")
    return hasRemoteEndpoint(current)
      ? store.entries.filter(
          (item) =>
            item.remote_address === current.remote_address &&
            hasRemoteEndpoint(item),
        )
      : [];
  if (kind.value === "local") return store.entries;
  if (kind.value === "endpoint")
    return store.entries.filter(
      (item) =>
        item.protocol === current.protocol &&
        item.local_address === current.local_address &&
        item.local_port === current.local_port,
    );
  const workloadIds = new Set(
    (display.value?.profiles ?? [])
      .filter(
        (profile) =>
          profile.component_role === "workload" &&
          profile.identity_match === "confirmed",
      )
      .map((profile) => profile.id),
  );
  return store.entries.filter(
    (item) =>
      (current.pid > 0 &&
        item.pid === current.pid &&
        item.process_created_at === current.process_created_at) ||
      (workloadIds.size > 0 &&
        item.service_profile_ids?.some((id) => workloadIds.has(id))) ||
      entryKey(item) === entryKey(current),
  );
});
watch(kind, () => {
  tab.value = "overview";
});
watch(
  () => store.selectedDetail?.entryKey,
  () => {
    if (entry.value) {
      void store.loadHostContext();
      if (hasRemoteEndpoint(entry.value))
        void store.loadHostContext(entry.value.remote_address!);
    }
  },
  { immediate: true },
);
const linkContext = computed(() => ({
  runtime: store.webReadOnly ? ("web" as const) : ("desktop" as const),
  scanHost: store.webReadOnly ? window.location.hostname : undefined,
  browserHost: window.location.hostname,
}));
function link(side: "local" | "remote", scheme?: "http" | "https") {
  return entry.value
    ? endpointLink(entry.value, side, { ...linkContext.value, scheme })
    : null;
}
function addressLink(side: "local" | "remote") {
  const automatic = link(side);
  return automatic?.url ? automatic : link(side, "http");
}
function addressLinkLabel(side: "local" | "remote") {
  return link(side)?.url ? t("possibleWeb") : t("tryHttp");
}
function safeUrl(value: string | null | undefined) {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
async function visit(event: MouseEvent, url: string | null | undefined) {
  if (
    store.webReadOnly &&
    (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
  )
    return;
  event.preventDefault();
  const destination = safeUrl(url);
  if (!destination) return;
  try {
    await openExternalUrl(destination);
  } catch (error) {
    store.notify(
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    store.notify("success", t("copied"));
  } catch (error) {
    store.notify(
      "error",
      t("copyFailed") +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
function sourceLabel(kind: string) {
  const keys: Record<string, TranslationKey> = {
    local: "localSource",
    catalog: "catalogSource",
    registry: "registrySource",
    github: "githubSource",
    search: "searchSource",
    ai: "aiSource",
  };
  return t(keys[kind] ?? "knowledgeSources");
}
function statusLabel(profile: ServiceProfile) {
  const keys: Record<ServiceProfile["enrichment_status"], TranslationKey> = {
    ready: "knowledgeReady",
    queued: "knowledgeQueued",
    offline: "knowledgeOffline",
    rate_limited: "knowledgeRateLimited",
    no_public_identifier: "knowledgeNoPublicId",
    disabled: "knowledgeDisabled",
    error: "knowledgeError",
  };
  return t(keys[profile.enrichment_status]);
}
function identityLabel(profile: ServiceProfile) {
  return t(
    profile.identity_match === "confirmed"
      ? "identityConfirmed"
      : profile.identity_match === "candidate"
        ? "identityCandidate"
        : "identityUnresolved",
  );
}
function dnsLabel(status: string) {
  const keys: Record<string, TranslationKey> = {
    ready: "dnsReady",
    queued: "dnsQueued",
    not_found: "dnsNotFound",
    timeout: "dnsTimeout",
    disabled: "dnsDisabled",
    not_applicable: "dnsNotApplicable",
    error: "dnsError",
  };
  return t(keys[status] ?? "unavailable");
}
function addressKind(value: string) {
  const names: Record<string, [string, string]> = {
    local: ["本机", "Local"],
    loopback: ["回环地址", "Loopback"],
    private: ["内网地址", "Private"],
    public: ["公网地址", "Public"],
    wildcard: ["通配监听地址", "Wildcard"],
    link_local: ["链路本地地址", "Link-local"],
    multicast: ["组播地址", "Multicast"],
    unspecified: ["未指定地址", "Unspecified"],
  };
  return names[value]?.[locale.value === "zh-CN" ? 0 : 1] ?? value;
}
function time(value: string | null) {
  if (!value) return t("unavailable");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale.value);
}
function detailsText() {
  const current = entry.value;
  if (!current) return "";
  return [
    display.value?.serviceName,
    display.value?.serviceDescription,
    t("serviceManager") +
      ": " +
      serviceManagerLabel(serviceManager(current), locale.value),
    t("localEndpoint") + ": " + localEndpoint(current),
    t("peer") + ": " + remoteEndpoint(current),
    "PID: " + current.pid,
    t("executable") + ": " + (current.process_path ?? t("unavailable")),
    ...(current.attributions ?? []).map((item) =>
      attributionDetails(item, locale.value, (value) =>
        backendText(locale.value, value),
      ),
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
function chooseTab(value: typeof tab.value) {
  tab.value = value;
}
async function tabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.findIndex((item) => item.id === tab.value);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tab.value = tabs[next]!.id;
  await nextTick();
  tabBar.value
    ?.querySelector<HTMLElement>('[data-tab="' + tab.value + '"]')
    ?.focus();
}
function close() {
  store.closeDetail();
}
function terminate() {
  if (entry.value) {
    store.selectEntry(entry.value);
    store.openKill();
  }
}
</script>
<template>
  <Dialog
    :visible="Boolean(store.selectedDetail && entry)"
    modal
    dismissableMask
    position="right"
    :draggable="false"
    :header="title"
    class="workbench-detail-drawer"
    :style="{
      width: '540px',
      maxWidth: '100vw',
      height: '100dvh',
      maxHeight: '100dvh',
      margin: '0',
    }"
    data-testid="detail-drawer"
    @update:visible="!$event && close()"
  >
    <template v-if="entry && display">
      <div class="detail-context">
        <span>{{
          kind === "service"
            ? t("serviceDetails")
            : kind === "endpoint"
              ? t("endpointDetails")
              : t("machineDetails")
        }}</span>
        <a
          v-if="addressLink(kind === 'remote' ? 'remote' : 'local')?.url"
          class="endpoint-address-link"
          :href="addressLink(kind === 'remote' ? 'remote' : 'local')!.url!"
          target="_blank"
          rel="noopener noreferrer"
          :title="addressLink(kind === 'remote' ? 'remote' : 'local')?.reason"
          @click="
            visit(
              $event,
              addressLink(kind === 'remote' ? 'remote' : 'local')?.url,
            )
          "
        >
          <code>{{
            kind === "remote" ? remoteEndpoint(entry) : localEndpoint(entry)
          }}</code>
          <small
            v-if="
              addressLink(kind === 'remote' ? 'remote' : 'local')?.kind !==
              'web'
            "
            >{{
              addressLinkLabel(kind === "remote" ? "remote" : "local")
            }}</small
          >
        </a>
        <code v-else>{{
          kind === "remote" ? remoteEndpoint(entry) : localEndpoint(entry)
        }}</code>
      </div>
      <div
        ref="tabBar"
        class="detail-tabs"
        role="tablist"
        :aria-label="t('serviceDetails')"
        @keydown="tabKey"
      >
        <button
          v-for="item in tabs"
          :id="'detail-tab-' + item.id"
          :key="item.id"
          :data-tab="item.id"
          role="tab"
          :aria-selected="tab === item.id"
          :aria-controls="'detail-panel-' + item.id"
          :tabindex="tab === item.id ? 0 : -1"
          :class="{ active: tab === item.id }"
          @click="chooseTab(item.id)"
        >
          {{ t(item.label)
          }}<small v-if="item.id === 'connections'">{{
            relatedEntries.length
          }}</small>
        </button>
      </div>
      <div
        :id="'detail-panel-' + tab"
        class="detail-panel"
        role="tabpanel"
        :aria-labelledby="'detail-tab-' + tab"
        tabindex="0"
      >
        <template v-if="tab === 'overview'">
          <section
            v-if="kind === 'service' || kind === 'endpoint'"
            class="detail-section"
          >
            <h3>{{ t("workloadSummary") }}</h3>
            <p class="detail-purpose">
              {{
                backendText(locale, workloadPurpose) || t("purposeUnavailable")
              }}
            </p>
            <dl class="detail-facts">
              <dt>{{ t("serviceManager") }}</dt>
              <dd>{{ serviceManagerLabel(serviceManager(entry), locale) }}</dd>
              <dt>{{ t("processOwner") }}</dt>
              <dd>
                {{ entry.process_name ?? t("unknownOwner") }}
                <span class="mono">· PID {{ entry.pid || "—" }}</span>
              </dd>
              <dt>{{ t("executable") }}</dt>
              <dd>
                <button
                  class="copy-value path mono"
                  :disabled="!entry.process_path"
                  @click="copy(entry.process_path ?? '')"
                >
                  {{ entry.process_path ?? t("unavailable") }}
                </button>
              </dd>
            </dl>
            <p v-if="kind === 'endpoint'" class="detail-relation">
              {{ relationSentence(entry, locale) }}
            </p>
          </section>
          <section
            v-if="kind === 'local' || kind === 'remote'"
            class="detail-section"
          >
            <h3>{{ kind === "remote" ? t("remote") : t("scanHost") }}</h3>
            <dl class="detail-facts">
              <dt>
                {{ kind === "remote" ? t("remoteAddress") : t("localAddress") }}
              </dt>
              <dd class="mono">
                {{
                  kind === "remote" ? entry.remote_address : entry.local_address
                }}
              </dd>
              <template v-if="host"
                ><dt>{{ t("addressKind") }}</dt>
                <dd>{{ addressKind(host.kind) }}</dd>
                <template v-if="host.machine_name"
                  ><dt>{{ t("machineName") }}</dt>
                  <dd>{{ host.machine_name }}</dd></template
                >
                <dt>
                  {{
                    host.hostname_source === "reverse_dns"
                      ? t("reverseDnsName")
                      : t("localHost")
                  }}
                </dt>
                <dd>{{ host.hostname ?? t("machineUnavailable") }}</dd>
                <dt>{{ t("state") }}</dt>
                <dd>{{ dnsLabel(host.dns_status) }}</dd>
                <template v-if="host.is_local && host.os"
                  ><dt>{{ t("operatingSystem") }}</dt>
                  <dd>{{ host.os }}</dd></template
                >
                <dt>{{ t("resolvedAt") }}</dt>
                <dd>{{ time(host.resolved_at) }}</dd></template
              ><template v-else
                ><dt>{{ t("machineName") }}</dt>
                <dd>{{ t("machineUnavailable") }}</dd></template
              >
            </dl>
            <p class="workbench-hint">
              {{
                kind === "remote" ? t("remoteFactsHint") : t("reverseDnsHint")
              }}
            </p>
            <p
              v-if="host?.hostname_source === 'reverse_dns'"
              class="detail-evidence-note"
            >
              {{ t("reverseDnsHint") }}
            </p>
            <div
              v-if="host?.is_local && host.observed_addresses.length"
              class="observed-addresses"
            >
              <h4>{{ t("observedAddresses") }}</h4>
              <button
                v-for="address in host.observed_addresses"
                :key="address"
                class="copy-value mono"
                @click="copy(address)"
              >
                {{ address }}
              </button>
            </div>
          </section>
          <section class="detail-section endpoint-access">
            <h3>{{ t("currentEndpoints") }}</h3>
            <article
              v-for="side in (hasRemoteEndpoint(entry)
                ? ['local', 'remote']
                : ['local']) as ('local' | 'remote')[]"
              :key="side"
              class="endpoint-access-card"
            >
              <header>
                <b>{{ side === "local" ? t("localEndpoint") : t("peer") }}</b
                ><span class="protocol" :class="entry.protocol.toLowerCase()">{{
                  entry.protocol.toUpperCase()
                }}</span>
              </header>
              <a
                v-if="addressLink(side)?.url"
                class="endpoint-address-link"
                :href="addressLink(side)!.url!"
                target="_blank"
                rel="noopener noreferrer"
                :title="addressLink(side)?.reason"
                @click="visit($event, addressLink(side)?.url)"
                ><code>{{
                  side === "local"
                    ? localEndpoint(entry)
                    : remoteEndpoint(entry)
                }}</code>
                <small v-if="addressLink(side)?.kind !== 'web'">{{
                  addressLinkLabel(side)
                }}</small>
              </a>
              <code v-else>{{
                side === "local" ? localEndpoint(entry) : remoteEndpoint(entry)
              }}</code>
              <div class="endpoint-access-actions">
                <a
                  v-if="link(side)?.url"
                  class="primary-link"
                  :href="link(side)!.url!"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="visit($event, link(side)?.url)"
                  >{{
                    link(side)?.kind === "possible-web"
                      ? t("possibleWeb") + " · " + t("openWeb")
                      : t("openWeb")
                  }}
                  ↗</a
                ><button
                  @click="
                    copy(
                      side === 'local'
                        ? localEndpoint(entry)
                        : remoteEndpoint(entry),
                    )
                  "
                >
                  {{ t("copyAddress") }}</button
                ><button @click="store.openDetail(side, entry)">
                  {{ t("machineDetails") }}
                </button>
              </div>
              <p class="workbench-hint">{{ link(side)?.reason }}</p>
              <div
                v-if="
                  link(side)?.kind !== 'web' &&
                  (link(side, 'http')?.url || link(side, 'https')?.url)
                "
                class="endpoint-protocol-options"
              >
                <a
                  v-for="scheme in ['http', 'https'] as const"
                  :key="scheme"
                  :href="link(side, scheme)?.url ?? undefined"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="visit($event, link(side, scheme)?.url)"
                  >{{ scheme === "http" ? t("tryHttp") : t("tryHttps") }}</a
                >
              </div>
            </article>
          </section>
          <section v-if="display.profiles.length" class="detail-section">
            <h3>{{ t("softwareSummary") }}</h3>
            <p class="workbench-hint">{{ t("softwareSummaryHint") }}</p>
            <article
              v-for="profile in display.profiles"
              :key="profile.id"
              class="knowledge-profile"
            >
              <header>
                <div>
                  <b>{{
                    profile.display_name_zh && locale === "zh-CN"
                      ? profile.display_name_zh
                      : profile.original_name
                  }}</b
                  ><small>{{ t(profile.component_role) }}</small>
                </div>
                <span class="identity-badge" :class="profile.identity_match">{{
                  identityLabel(profile)
                }}</span>
              </header>
              <p v-if="profile.summary" class="profile-instance-summary">
                <b>{{ t("workloadSummary") }}：</b
                >{{ backendText(locale, profile.summary) }}
              </p>
              <p v-if="profile.software_summary">
                {{ backendText(locale, profile.software_summary) }}
              </p>
              <p
                v-if="!profile.summary && !profile.software_summary"
                class="workbench-hint"
              >
                {{ t("purposeUnavailable") }}
              </p>
              <div class="knowledge-status" :class="profile.enrichment_status">
                {{ statusLabel(profile) }}
              </div>
              <p v-if="profile.stale" class="detail-evidence-note">
                {{ t("knowledgeStale") }}
              </p>
              <small v-if="profile.updated_at" class="workbench-hint"
                >{{ t("knowledgeUpdated") }} ·
                {{ time(profile.updated_at) }}</small
              >
            </article>
          </section>
        </template>
        <template v-else-if="tab === 'evidence'">
          <section class="detail-section">
            <h3>{{ t("processAndAttribution") }}</h3>
            <dl class="detail-facts">
              <dt>{{ t("processOwner") }}</dt>
              <dd>{{ entry.process_name ?? t("unknownOwner") }}</dd>
              <dt>PID</dt>
              <dd class="mono">{{ entry.pid || "—" }}</dd>
              <dt>{{ t("processState") }}</dt>
              <dd>
                {{
                  processStatusLabel(
                    locale,
                    entry.process_status,
                    entry.process_status_message,
                  )
                }}
              </dd>
              <dt>{{ t("created") }}</dt>
              <dd class="mono">
                {{ entry.process_created_at ?? t("unavailable") }}
              </dd>
              <dt>{{ t("executable") }}</dt>
              <dd>
                <button
                  class="copy-value path mono"
                  :disabled="!entry.process_path"
                  @click="copy(entry.process_path ?? '')"
                >
                  {{ entry.process_path ?? t("unavailable") }}
                </button>
              </dd>
              <dt>{{ t("scanned") }}</dt>
              <dd>{{ time(store.scannedAt) }}</dd>
            </dl>
          </section>
          <section class="detail-section">
            <h3>{{ t("serviceAttribution") }}</h3>
            <p v-if="!entry.attributions.length" class="workbench-hint">
              {{
                entry.pid === 0
                  ? t("attributionLimitedHint")
                  : t("processOnlyHint")
              }}
            </p>
            <article
              v-for="item in entry.attributions"
              :key="item.kind + item.name + item.source"
              class="evidence-card"
            >
              <header>
                <div>
                  <small>{{ kindLabel(item.kind, locale) }}</small>
                  <h4>{{ backendText(locale, item.name) }}</h4>
                </div>
                <span
                  class="confidence"
                  :class="item.confidence.toLowerCase()"
                  >{{ confidenceLabel(item.confidence, locale) }}</span
                >
              </header>
              <p v-if="item.description">
                {{ backendText(locale, item.description) }}
              </p>
              <dl class="detail-facts">
                <template
                  v-for="fact in item.facts"
                  :key="fact.label + fact.value"
                  ><dt>{{ backendText(locale, fact.label) }}</dt>
                  <dd>
                    <button
                      class="copy-value path mono"
                      @click="copy(fact.value)"
                    >
                      {{ backendText(locale, fact.value) }}
                    </button>
                  </dd></template
                >
              </dl>
              <p class="detail-evidence-note">
                {{ t("source", { source: backendText(locale, item.source) }) }}
              </p>
            </article>
          </section>
          <section
            v-for="profile in display.profiles"
            :key="profile.id"
            class="detail-section"
          >
            <h3>
              {{
                profile.display_name_zh && locale === "zh-CN"
                  ? profile.display_name_zh
                  : profile.original_name
              }}
            </h3>
            <dl class="detail-facts">
              <dt>{{ t("originalName") }}</dt>
              <dd>{{ profile.original_name }}</dd>
              <dt>{{ t("confidence") }}</dt>
              <dd>{{ identityLabel(profile) }}</dd>
            </dl>
            <h4>{{ t("knowledgeSources") }}</h4>
            <ul class="knowledge-source-list">
              <li v-for="source in profile.sources" :key="source.id">
                <span class="source-kind">{{ sourceLabel(source.kind) }}</span
                ><a
                  v-if="safeUrl(source.url)"
                  :href="safeUrl(source.url)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="visit($event, source.url)"
                  >{{ source.title }} ↗</a
                ><span v-else>{{ source.title }}</span
                ><small v-if="source.fetched_at">{{
                  time(source.fetched_at)
                }}</small>
              </li>
            </ul>
            <template v-if="profile.candidates.length"
              ><h4>{{ t("knowledgeCandidates") }}</h4>
              <p class="detail-evidence-note">{{ t("candidateHint") }}</p>
              <article
                v-for="candidate in profile.candidates"
                :key="candidate.url"
                class="candidate-card"
              >
                <a
                  v-if="safeUrl(candidate.url)"
                  :href="safeUrl(candidate.url)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click="visit($event, candidate.url)"
                  >{{ candidate.name }} ↗</a
                ><b v-else>{{ candidate.name }}</b>
                <p v-if="candidate.description">{{ candidate.description }}</p>
              </article></template
            >
            <p v-if="profile.message" class="workbench-hint">
              {{ profile.message }}
            </p>
          </section>
          <section class="detail-section">
            <h3>{{ t("connectionRelation") }}</h3>
            <p>{{ relationSentence(entry, locale) }}</p>
            <p class="detail-evidence-note">
              {{ t(analyzeConnection(entry).evidenceKey) }}
            </p>
            <p
              v-if="analyzeConnection(entry).confidence !== 'exact'"
              class="workbench-hint"
            >
              {{ t("inferenceWarning") }}
            </p>
          </section>
        </template>
        <section v-else class="detail-section related-connections">
          <h3>
            {{ t("relatedConnections") }}
            <small>{{ relatedEntries.length }}</small>
          </h3>
          <VirtualScroller
            v-if="relatedEntries.length"
            :key="kind + ':' + store.selectedDetail?.entryKey"
            :items="relatedEntries"
            :itemSize="64"
            :numToleratedItems="6"
            :disabled="relatedEntries.length <= 100"
            class="related-virtual-list"
            :class="{ virtualized: relatedEntries.length > 100 }"
            data-testid="related-connections-list"
          >
            <template
              #content="{
                items,
                contentRef,
                styleClass,
                contentStyle,
                getItemOptions,
              }"
            >
              <div :ref="contentRef" :class="styleClass" :style="contentStyle">
                <button
                  v-for="(item, index) in items"
                  :key="entryKey(item)"
                  class="related-connection"
                  :class="{ active: entryKey(item) === entryKey(entry) }"
                  :aria-posinset="
                    (getItemOptions?.(Number(index))?.index ?? Number(index)) +
                    1
                  "
                  :aria-setsize="relatedEntries.length"
                  :title="
                    localEndpoint(item) +
                    (hasRemoteEndpoint(item)
                      ? ' → ' + remoteEndpoint(item)
                      : '')
                  "
                  @click="store.openDetail(kind, item)"
                >
                  <span class="protocol" :class="item.protocol.toLowerCase()">{{
                    item.protocol.toUpperCase()
                  }}</span
                  ><span
                    ><b>{{ store.displayFor(item).serviceName }}</b
                    ><code
                      >{{ localEndpoint(item)
                      }}{{
                        hasRemoteEndpoint(item)
                          ? " → " + remoteEndpoint(item)
                          : ""
                      }}</code
                    ></span
                  ><small>{{
                    item.protocol === "Tcp" ? state(item.state) : "UDP"
                  }}</small>
                </button>
              </div>
            </template>
          </VirtualScroller>
          <p v-else class="workbench-hint">{{ t("noEndpoints") }}</p>
        </section>
      </div>
    </template>
    <template #footer
      ><button @click="copy(detailsText())">{{ t("copyDetails") }}</button
      ><button
        :disabled="store.knowledgeBusy"
        @click="store.refreshKnowledge(true)"
      >
        {{ t("refreshKnowledge") }}</button
      ><button
        class="danger-text"
        :disabled="!entry || !store.canKill(entry)"
        :title="entry && store.canKill(entry) ? '' : t('terminateDisabled')"
        @click="terminate"
      >
        {{ t("terminate") }}
      </button></template
    >
  </Dialog>
</template>

<style scoped>
.endpoint-address-link {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.endpoint-address-link code {
  overflow-wrap: anywhere;
}
.endpoint-address-link small {
  font-size: 10px;
  color: var(--muted);
}
.related-virtual-list.virtualized {
  height: min(60dvh, 560px);
  overflow: auto;
}
.related-connection {
  height: 64px;
  min-height: 64px;
  max-height: 64px;
  flex-shrink: 0;
  box-sizing: border-box;
  overflow: hidden;
}
.related-connection code {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

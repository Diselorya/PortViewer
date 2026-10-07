<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../stores/app";
import { confidenceLabel, kindLabel } from "../domain/attribution";
import {
  analyzeConnection,
  localEndpoint,
  relationSentence,
  remoteEndpoint,
} from "../domain/connectionRelation";
import { backendText, processStatusLabel, useI18n } from "../i18n";
import type { PortEntry } from "../types/port";

const store = useAppStore();
const { locale, state, t } = useI18n();
const entry = computed(() => store.selectedEntry!);
const relation = computed(() => analyzeConnection(entry.value));
const sentence = computed(() => relationSentence(entry.value, locale.value));
const confidenceText = computed(() =>
  t(
    relation.value.confidence === "exact"
      ? "certain"
      : relation.value.confidence,
  ),
);

function endpoint(e: PortEntry) {
  return e.protocol === "Udp" || !e.remote_address
    ? localEndpoint(e)
    : `${localEndpoint(e)} → ${remoteEndpoint(e)}`;
}
async function copy(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    store.notify(
      "success",
      locale.value === "zh-CN" ? `已复制${label}` : `${label} copied`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    store.notify(
      "error",
      locale.value === "zh-CN"
        ? `复制${label}失败：${detail}`
        : `Failed to copy ${label}: ${detail}`,
    );
  }
}
function details() {
  const e = entry.value;
  return [
    sentence.value,
    `${t("localEndpoint")}: ${localEndpoint(e)}`,
    `${t("peer")}: ${remoteEndpoint(e)}`,
    `${t("state")}: ${e.protocol === "Tcp" ? state(e.state) : "UDP"}`,
    `PID: ${e.pid}`,
    `${t("processOwner")}: ${e.process_name ?? processStatusLabel(locale.value, e.process_status, e.process_status_message)}`,
    `${t("executable")}: ${e.process_path ?? t("unavailable")}`,
    `${t("evidence")}: ${t(relation.value.evidenceKey)}`,
  ].join("\n");
}
</script>

<template>
  <aside class="inspector relation-inspector" :aria-label="t('inspectorAria')">
    <header>
      <div>
        <small>{{ t("connectionRelation") }}</small>
        <h2>{{ t(relation.titleKey) }}</h2>
      </div>
      <button
        class="icon-btn"
        :aria-label="t('closeDetails')"
        @click="store.selectEntry(null)"
      >
        ×
      </button>
    </header>
    <section class="relation-summary">
      <p class="relation-sentence">{{ sentence }}</p>
      <div class="endpoint-flow">
        <article>
          <small>{{ t("localEndpoint") }}</small
          ><b class="mono">{{ localEndpoint(entry) }}</b
          ><span>{{ entry.process_name ?? `PID ${entry.pid}` }}</span>
        </article>
        <div class="flow-arrow" :class="`role-${relation.role}`">
          <b>{{ relation.arrow }}</b
          ><small>{{ t(relation.titleKey) }}</small>
        </div>
        <article>
          <small>{{ t("peer") }}</small
          ><b class="mono">{{ remoteEndpoint(entry) }}</b
          ><span>{{
            entry.remote_address ? relation.service : t("noFixedPeer")
          }}</span>
        </article>
      </div>
      <dl class="relation-facts">
        <div>
          <dt>{{ t("initiator") }}</dt>
          <dd>{{ t(relation.initiatorKey) }}</dd>
        </div>
        <div>
          <dt>{{ t("provider") }}</dt>
          <dd>{{ t(relation.providerKey) }}</dd>
        </div>
        <div>
          <dt>{{ t("confidence") }}</dt>
          <dd>
            <span class="confidence" :class="relation.confidence">{{
              confidenceText
            }}</span>
          </dd>
        </div>
      </dl>
      <div class="evidence-callout">
        <b>{{ t("evidence") }}</b
        ><span>{{ t(relation.evidenceKey) }}</span>
      </div>
      <p v-if="relation.confidence !== 'exact'" class="inference-warning">
        {{ t("inferenceWarning") }}
      </p>
    </section>

    <section class="process-section">
      <h3>{{ t("processAndAttribution") }}</h3>
      <dl class="process-facts">
        <dt>{{ t("processOwner") }}</dt>
        <dd>
          <button
            class="copy-value"
            :disabled="!entry.process_name"
            @click="copy(t('processOwner'), entry.process_name ?? '')"
          >
            {{
              entry.process_name ??
              processStatusLabel(
                locale,
                entry.process_status,
                entry.process_status_message,
              )
            }}
          </button>
        </dd>
        <dt>PID</dt>
        <dd>
          <button
            class="copy-value mono"
            @click="copy('PID', String(entry.pid))"
          >
            {{ entry.pid }}
          </button>
        </dd>
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
        <dt>{{ t("executable") }}</dt>
        <dd>
          <button
            class="copy-value mono path"
            :disabled="!entry.process_path"
            @click="
              copy(
                locale === 'zh-CN' ? '路径' : 'path',
                entry.process_path ?? '',
              )
            "
          >
            {{ entry.process_path ?? t("unavailable") }}
          </button>
        </dd>
        <dt>{{ t("created") }}</dt>
        <dd class="mono">{{ entry.process_created_at ?? t("unavailable") }}</dd>
        <dt>{{ t("scanned") }}</dt>
        <dd class="mono">{{ store.scannedAt ?? t("unavailable") }}</dd>
      </dl>
    </section>

    <section class="workload-section">
      <h3>
        {{ t("serviceAttribution") }}
        <span>{{ entry.attributions?.length ?? 0 }}</span>
      </h3>
      <div v-if="entry.attributions?.length" class="workload-list">
        <article
          v-for="(item, index) in entry.attributions"
          :key="`${item.kind}-${item.name}-${item.source}`"
          class="workload-card"
          :class="{ primary: index === 0 }"
        >
          <header>
            <div>
              <small>{{ kindLabel(item.kind, locale) }}</small
              ><b>{{ backendText(locale, item.name) }}</b>
            </div>
            <span class="confidence" :class="item.confidence.toLowerCase()">{{
              confidenceLabel(item.confidence, locale)
            }}</span>
          </header>
          <p v-if="item.description">
            {{ backendText(locale, item.description) }}
          </p>
          <dl v-if="item.facts.length">
            <template v-for="fact in item.facts" :key="fact.label + fact.value"
              ><dt>{{ backendText(locale, fact.label) }}</dt>
              <dd class="mono">
                {{ backendText(locale, fact.value) }}
              </dd></template
            >
          </dl>
          <small class="evidence">{{
            t("source", { source: backendText(locale, item.source) })
          }}</small>
        </article>
      </div>
      <div v-else class="workload-empty">
        <b>{{ t("processOnlyTitle") }}</b>
        <p>
          {{
            entry.process_status === "AccessDenied"
              ? t("permissionLimited", { count: 1 })
              : t("processOnlyHint")
          }}
        </p>
      </div>
    </section>

    <section class="endpoints">
      <h3>
        {{ t("currentEndpoints") }}
        <span>{{ store.selectedProcessEntries.length }}</span>
      </h3>
      <button
        v-for="e in store.selectedProcessEntries"
        :key="`${e.protocol}-${endpoint(e)}`"
        :class="{ active: e === entry }"
        @click="store.selectEntry(e)"
      >
        <span class="protocol" :class="e.protocol.toLowerCase()">{{
          e.protocol.toUpperCase()
        }}</span
        ><span class="mono">{{ endpoint(e) }}</span
        ><small>{{ e.protocol === "Tcp" ? state(e.state) : "UDP" }}</small>
      </button>
    </section>
    <footer>
      <button @click="copy(t('copyDetails'), details())">
        {{ t("copyDetails") }}</button
      ><button
        class="danger-text"
        :disabled="!store.canKill(entry)"
        :title="store.canKill(entry) ? '' : t('terminateDisabled')"
        @click="store.openKill"
      >
        {{ t("terminate") }}
      </button>
    </footer>
  </aside>
</template>

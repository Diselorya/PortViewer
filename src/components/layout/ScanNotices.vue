<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useI18n } from "../../i18n";

const store = useAppStore(),
  { locale, t } = useI18n(),
  expanded = ref(false);
const notices = computed(() => {
  const result: Array<{ kind: "warning" | "danger" | "info"; text: string }> =
    [];
  if (store.settingsRecovered)
    result.push({ kind: "warning", text: t("settingsRecovered") });
  if (store.scanError)
    result.push({
      kind: "danger",
      text: store.stale
        ? `${t("staleData", { time: store.scannedAt ? new Date(store.scannedAt).toLocaleTimeString(locale.value) : "—" })} ${store.scanError}`
        : store.scanError,
    });
  if (store.scanIssues.length)
    result.push({
      kind: "warning",
      text: t("scopeUnavailable", {
        issues: store.scanIssues.join(locale.value === "zh-CN" ? "；" : "; "),
      }),
    });
  if (store.attributionIssues.length)
    result.push({
      kind: "warning",
      text: t("attributionUnavailable", {
        issues: store.attributionIssues.join(
          locale.value === "zh-CN" ? "；" : "; ",
        ),
      }),
    });
  if (store.hasExplicitPermissionIssue)
    result.push({
      kind: "warning",
      text:
        store.permissionLimitedCount > 0
          ? t("permissionLimited", { count: store.permissionLimitedCount })
          : t("attributionPermissionLimited"),
    });
  if (store.knowledgeError)
    result.push({
      kind: "warning",
      text: t("knowledgeError") + ": " + store.knowledgeError,
    });
  const profileFailures = { offline: 0, rate_limited: 0, error: 0 };
  for (const profile of store.serviceProfiles.values()) {
    const status = profile.enrichment_status;
    if (status === "offline" || status === "rate_limited" || status === "error")
      profileFailures[status]++;
  }
  for (const [status, label] of [
    ["offline", "knowledgeOffline"],
    ["rate_limited", "knowledgeRateLimited"],
    ["error", "knowledgeError"],
  ] as const) {
    if (profileFailures[status])
      result.push({
        kind: "warning",
        text: t(label) + " · " + profileFailures[status],
      });
  }
  if (store.knowledgePending > 0)
    result.push({
      kind: "info",
      text: t("knowledgeQueued") + " · " + store.knowledgePending,
    });
  return result;
});
watch(
  () => notices.value.length,
  (count) => {
    if (!count) expanded.value = false;
  },
);

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(
      notices.value.map((notice) => notice.text).join("\n\n"),
    );
    store.notify(
      "info",
      locale.value === "zh-CN" ? "诊断信息已复制" : "Diagnostics copied",
    );
  } catch (error) {
    store.notify(
      "error",
      `${t("copyDiagnostics")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
async function requestElevation() {
  if (!window.confirm(t("elevateConfirm"))) return;
  try {
    const result = await store.restartElevated();
    if (result === "UacCancelled") store.notify("info", t("uacCancelled"));
    else if (result === "AlreadyElevated")
      store.notify("info", t("alreadyElevated"));
    else if (result === "PolicyBlocked")
      store.notify("error", t("elevationBlocked"));
    else if (result === "LaunchFailed")
      store.notify("error", t("elevationFailed"));
  } catch (error) {
    store.notify(
      "error",
      `${t("elevationFailed")} ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
</script>

<template>
  <section
    class="scan-notices"
    data-testid="scan-notices"
    :class="{ 'has-notices': notices.some((notice) => notice.kind !== 'info') }"
    :aria-label="t('scanNotices')"
    @keydown.esc="expanded = false"
  >
    <button
      class="scan-notices-toggle"
      data-testid="scan-notices-toggle"
      :disabled="!notices.length"
      :aria-expanded="expanded"
      aria-controls="scan-notices-details"
      :aria-label="expanded ? t('hideDiagnostics') : t('showDiagnostics')"
      @click="expanded = !expanded"
    >
      {{ expanded ? "▾" : "▸" }}
      {{
        notices.length
          ? t("noticeCount", { count: notices.length })
          : t("noScanNotices")
      }}
    </button>
    <span
      class="scan-notices-summary"
      role="status"
      aria-live="polite"
      :title="notices[0]?.text"
      >{{ notices[0]?.text }}</span
    >
    <button
      v-if="store.canRequestElevation"
      class="elevate-btn"
      :disabled="store.elevationBusy"
      @click="requestElevation"
    >
      {{ store.elevationBusy ? t("elevateBusy") : t("elevate") }}
    </button>
    <div
      v-if="expanded && notices.length"
      id="scan-notices-details"
      class="scan-notices-details"
      :aria-label="t('scanNotices')"
    >
      <header>
        <b>{{ t("scanNotices") }}</b
        ><button
          class="icon-btn"
          :aria-label="t('hideDiagnostics')"
          @click="expanded = false"
        >
          ×
        </button>
      </header>
      <p v-for="(notice, index) in notices" :key="index" :class="notice.kind">
        {{ notice.text }}
      </p>
      <footer>
        <button @click="store.refresh">{{ t("retry") }}</button
        ><button @click="copyDiagnostics">{{ t("copyDiagnostics") }}</button
        ><button
          v-if="store.settingsRecovered"
          @click="store.settingsRecovered = false"
        >
          {{ t("close") }}
        </button>
      </footer>
    </div>
  </section>
</template>

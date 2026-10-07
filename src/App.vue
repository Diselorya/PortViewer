<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppHeader from "./components/layout/AppHeader.vue";
import AppStatusBar from "./components/layout/AppStatusBar.vue";
import PortTableToolbar from "./components/port-table/PortTableToolbar.vue";
import PortTable from "./components/port-table/PortTable.vue";
import ProcessInspector from "./components/ProcessInspector.vue";
import SettingsDialog from "./components/dialogs/SettingsDialog.vue";
import ConfirmKillDialog from "./components/dialogs/ConfirmKillDialog.vue";
import AboutDialog from "./components/dialogs/AboutDialog.vue";
import { useAppStore } from "./stores/app";
import { useI18n } from "./i18n";
const store = useAppStore(),
  headerRef = ref<{ focusSearch: () => void } | null>(null);
const { locale, t } = useI18n();
function applyTheme() {
  const dark =
    store.settings.theme === "dark" ||
    (store.settings.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.density = store.settings.density;
}
function shortcuts(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  if (
    (e.ctrlKey && e.key.toLowerCase() === "f") ||
    (!typing && e.key === "/")
  ) {
    e.preventDefault();
    headerRef.value?.focusSearch();
  } else if (e.key === "Escape" && store.query) {
    store.query = "";
  } else if (e.ctrlKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    store.download("csv");
  } else if (e.key === "F5") {
    e.preventDefault();
    void store.refresh();
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
const media = matchMedia("(prefers-color-scheme: dark)");
watch(() => store.settings, applyTheme, { deep: true, immediate: true });
watch(
  locale,
  (value) => {
    document.documentElement.lang = value;
  },
  { immediate: true },
);
media.addEventListener("change", applyTheme);
onMounted(async () => {
  window.addEventListener("keydown", shortcuts);
  await nextTick();
  void store.start();
});
onBeforeUnmount(() => {
  store.stop();
  window.removeEventListener("keydown", shortcuts);
  media.removeEventListener("change", applyTheme);
});
</script>
<template>
  <div class="app-shell">
    <AppHeader ref="headerRef" /><PortTableToolbar />
    <div v-if="store.webReadOnly" class="banner info" role="status">
      {{ t("webReadOnly") }}
    </div>
    <div v-if="store.settingsRecovered" class="banner warning">
      {{ t("settingsRecovered")
      }}<button @click="store.settingsRecovered = false">
        {{ t("close") }}
      </button>
    </div>
    <div v-if="store.scanError && store.stale" class="banner danger">
      <span>{{
        t("staleData", {
          time: new Date(store.scannedAt!).toLocaleTimeString(locale),
        })
      }}</span
      ><button @click="store.refresh">{{ t("retry") }}</button
      ><code>{{ store.scanError }}</code>
    </div>
    <div v-if="store.scanIssues.length" class="banner warning" role="status">
      {{
        t("scopeUnavailable", {
          issues: store.scanIssues.join(locale === "zh-CN" ? "；" : "; "),
        })
      }}<button @click="store.refresh">{{ t("retry") }}</button>
    </div>
    <div
      v-if="store.attributionIssues.length"
      class="banner warning"
      role="status"
    >
      {{
        t("attributionUnavailable", {
          issues: store.attributionIssues.join(
            locale === "zh-CN" ? "；" : "; ",
          ),
        })
      }}
    </div>
    <div
      v-if="store.hasExplicitPermissionIssue"
      class="banner warning elevation-banner"
    >
      <span>{{
        store.permissionLimitedCount > 0
          ? t("permissionLimited", { count: store.permissionLimitedCount })
          : t("attributionPermissionLimited")
      }}</span>
      <button
        v-if="store.canRequestElevation"
        class="elevate-btn"
        :disabled="store.elevationBusy"
        @click="requestElevation"
      >
        {{ store.elevationBusy ? t("elevateBusy") : t("elevate") }}
      </button>
    </div>
    <main class="workspace">
      <section class="table-pane"><PortTable /></section>
      <ProcessInspector v-if="store.selectedEntry" />
    </main>
    <AppStatusBar /><SettingsDialog /><ConfirmKillDialog /><AboutDialog />
    <div
      v-if="store.notification"
      class="notice"
      :class="store.notification.type"
      role="status"
      aria-live="polite"
    >
      {{ store.notification.text }}
    </div>
  </div>
</template>

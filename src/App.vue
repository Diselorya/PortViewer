<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppHeader from "./components/layout/AppHeader.vue";
import AppStatusBar from "./components/layout/AppStatusBar.vue";
import ScanNotices from "./components/layout/ScanNotices.vue";
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
    <main class="workspace">
      <section class="table-pane"><PortTable /></section>
      <ProcessInspector v-if="store.selectedEntry" />
    </main>
    <ScanNotices /><AppStatusBar /><SettingsDialog /><ConfirmKillDialog /><AboutDialog />
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

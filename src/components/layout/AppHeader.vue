<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app";
import { useI18n } from "../../i18n";
const store = useAppStore(),
  searchInput = ref<HTMLInputElement | null>(null);
const { t } = useI18n();
const placeholder = computed(() =>
  store.hasScanned ? t("searchReady") : t("searchWaiting"),
);
defineExpose({ focusSearch: () => searchInput.value?.focus() });
</script>
<template>
  <header class="app-header">
    <div class="brand" aria-label="PortViewer">
      <span class="brand-mark" aria-hidden="true">PV</span>
      <div>
        <h1>PortViewer</h1>
        <small>{{ t("appSubtitle") }}</small>
      </div>
    </div>
    <div class="search-wrap">
      <span aria-hidden="true">⌕</span
      ><input
        ref="searchInput"
        v-model="store.query"
        type="search"
        :disabled="!store.hasScanned"
        :placeholder="placeholder"
        :aria-label="t('searchReady')"
        autocomplete="off"
      /><kbd>Ctrl F</kbd
      ><button
        v-if="store.query"
        class="icon-btn"
        :aria-label="t('clearSearch')"
        @click="store.query = ''"
      >
        ×
      </button>
    </div>
    <div class="header-actions">
      <button
        class="tool-btn"
        :disabled="store.isScanning"
        :aria-label="`${t('refresh')} · F5`"
        @click="store.refresh"
      >
        <span :class="{ spin: store.isScanning }">↻</span
        ><span>{{ t("refresh") }}</span></button
      ><button
        class="icon-btn"
        :aria-label="t('openSettings')"
        @click="store.settingsVisible = true"
      >
        ⚙
      </button>
      <button
        class="icon-btn"
        :aria-label="t('openAbout')"
        @click="store.aboutVisible = true"
      >
        ⓘ
      </button>
    </div>
  </header>
</template>

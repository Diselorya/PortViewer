<script setup lang="ts">
import Dialog from "primevue/dialog";
import { useAppStore } from "../../stores/app";
import type {
  AppSettings,
  LanguageOption,
  TableDensity,
  ThemeOption,
} from "../../types/settings";
import { computed } from "vue";
import { useI18n } from "../../i18n";
const store = useAppStore();
const { t } = useI18n();
const intervals = computed(() =>
  ([0, 1000, 2000, 5000, 10000, 30000, 60000] as const).map(
    (value) =>
      [
        value ? t("seconds", { count: value / 1000 }) : t("off"),
        value,
      ] as const,
  ),
);
function patch<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  store.updateSettings({ [key]: value });
}
</script>
<template>
  <Dialog
    v-model:visible="store.settingsVisible"
    modal
    :header="t('settings')"
    :style="{ width: '560px' }"
    class="settings-dialog"
    ><div class="settings-section">
      <h3>{{ t("scan") }}</h3>
      <label
        ><span
          >{{ t("autoRefresh") }}<small>{{ t("autoRefreshHint") }}</small></span
        ><select
          :value="store.settings.refreshIntervalMs"
          @change="
            patch(
              'refreshIntervalMs',
              Number(
                ($event.target as HTMLSelectElement).value,
              ) as AppSettings['refreshIntervalMs'],
            )
          "
        >
          <option v-for="o in intervals" :key="o[1]" :value="o[1]">
            {{ o[0] }}
          </option>
        </select></label
      ><label
        ><span
          >{{ t("maxRows") }}<small>{{ t("maxRowsHint") }}</small></span
        ><select
          :value="store.settings.maxEntries"
          @change="
            patch(
              'maxEntries',
              Number(
                ($event.target as HTMLSelectElement).value,
              ) as AppSettings['maxEntries'],
            )
          "
        >
          <option v-for="n in [1000, 10000, 50000, 100000]" :key="n" :value="n">
            {{ n.toLocaleString() }}
          </option>
        </select></label
      ><label
        ><span>{{ t("scanStartup") }}</span
        ><input
          type="checkbox"
          :checked="store.settings.scanOnStartup"
          @change="
            patch('scanOnStartup', ($event.target as HTMLInputElement).checked)
          "
      /></label>
    </div>
    <div class="settings-section">
      <h3>{{ t("appearance") }}</h3>
      <label
        ><span
          >{{ t("language") }}<small>{{ t("languageHint") }}</small></span
        ><select
          :value="store.settings.language"
          @change="
            patch(
              'language',
              ($event.target as HTMLSelectElement).value as LanguageOption,
            )
          "
        >
          <option value="system">{{ t("languageSystem") }}</option>
          <option value="zh-CN">{{ t("languageZh") }}</option>
          <option value="en-US">{{ t("languageEn") }}</option>
        </select></label
      >
      <label
        ><span>{{ t("theme") }}</span
        ><select
          :value="store.settings.theme"
          @change="
            patch(
              'theme',
              ($event.target as HTMLSelectElement).value as ThemeOption,
            )
          "
        >
          <option value="system">{{ t("themeSystem") }}</option>
          <option value="light">{{ t("themeLight") }}</option>
          <option value="dark">{{ t("themeDark") }}</option>
        </select></label
      ><label
        ><span>{{ t("density") }}</span
        ><select
          :value="store.settings.density"
          @change="
            patch(
              'density',
              ($event.target as HTMLSelectElement).value as TableDensity,
            )
          "
        >
          <option value="compact">{{ t("compact") }}</option>
          <option value="standard">{{ t("standard") }}</option>
          <option value="comfortable">{{ t("comfortable") }}</option>
        </select></label
      >
    </div>
    <div class="privacy">
      <b>{{ t("privacy") }}</b
      ><span>{{ t("privacyText") }}</span>
    </div>
    <template #footer
      ><button class="danger-text" @click="store.resetConfirmVisible = true">
        {{ t("resetSettings") }}</button
      ><span /><button
        class="primary-btn"
        @click="store.settingsVisible = false"
      >
        {{ t("close") }}
      </button></template
    ></Dialog
  ><Dialog
    v-model:visible="store.resetConfirmVisible"
    modal
    :header="t('resetTitle')"
    :style="{ width: '420px' }"
    ><p>{{ t("resetText") }}</p>
    <template #footer
      ><button autofocus @click="store.resetConfirmVisible = false">
        {{ t("cancel") }}</button
      ><button class="danger-btn" @click="store.resetSettings">
        {{ t("resetConfirm") }}
      </button></template
    ></Dialog
  >
</template>

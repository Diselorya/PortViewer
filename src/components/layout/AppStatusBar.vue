<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app";
import { backendText, useI18n } from "../../i18n";
const store = useAppStore();
const { locale } = useI18n();
const time = computed(() =>
  store.scannedAt
    ? new Date(store.scannedAt).toLocaleTimeString(locale.value, {
        hour12: false,
      })
    : locale.value === "zh-CN"
      ? "尚未扫描"
      : "Not scanned",
);
const state = computed(() =>
  store.isScanning
    ? locale.value === "zh-CN"
      ? "正在刷新"
      : "Refreshing"
    : store.scanError
      ? locale.value === "zh-CN"
        ? "扫描异常"
        : "Scan error"
      : locale.value === "zh-CN"
        ? "就绪"
        : "Ready",
);
</script>
<template>
  <footer class="statusbar">
    <div>
      <span
        >{{ locale === "zh-CN" ? "显示" : "Showing" }}
        {{ store.viewEntries.length }} /
        {{ locale === "zh-CN" ? "命中" : "matched" }}
        {{ store.filteredEntries.length }} ·
        {{ locale === "zh-CN" ? "总计" : "total" }}
        {{ store.entries.length }}</span
      ><span v-if="store.isTruncated" class="warning-text">{{
        locale === "zh-CN" ? "结果已截断" : "Results truncated"
      }}</span
      ><span>{{ locale === "zh-CN" ? "采集于" : "Scanned" }} {{ time }}</span
      ><span>{{ store.scanDurationMs }} ms</span>
    </div>
    <div>
      <span>{{ store.scanScope }}</span
      ><span
        >{{ locale === "zh-CN" ? "权限" : "Access" }}：{{
          store.privilegeStatusError
            ? locale === "zh-CN"
              ? "状态未知"
              : "Unknown"
            : !store.privilegeStatus
              ? locale === "zh-CN"
                ? "正在检测"
                : "Detecting"
              : store.privilegeStatus.is_elevated
                ? locale === "zh-CN"
                  ? "管理员模式"
                  : "Administrator mode"
                : locale === "zh-CN"
                  ? "标准模式"
                  : "Standard mode"
        }}</span
      ><span
        :title="
          store.attributionReports
            .map(
              (item) =>
                `${backendText(locale, item.resolver)}: ${item.status}${locale === 'zh-CN' && item.message ? ` · ${item.message}` : ''}`,
            )
            .join('\n')
        "
        >{{ locale === "zh-CN" ? "归属" : "Attributed" }}：{{
          store.attributionMatchedCount
        }}/{{ store.entries.length }}</span
      ><span
        class="health"
        :class="{ busy: store.isScanning, error: store.scanError }"
        ><i />{{ state }}</span
      >
    </div>
  </footer>
</template>

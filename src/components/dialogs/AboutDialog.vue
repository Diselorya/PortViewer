<script setup lang="ts">
import { computed } from "vue";
import Dialog from "primevue/dialog";
import { useAppStore } from "../../stores/app";
import { PRODUCT_VERSION } from "../../domain/appMetadata";
import { useI18n } from "../../i18n";

const store = useAppStore();
const { locale } = useI18n();
const diagnostic = computed(() =>
  [
    `PortViewer ${PRODUCT_VERSION}`,
    `${locale.value === "zh-CN" ? "平台" : "Platform"}: Windows 10/11 x64`,
    `${locale.value === "zh-CN" ? "扫描范围" : "Scan scope"}: ${store.scanScope}`,
    `${locale.value === "zh-CN" ? "最新成功时间" : "Latest success"}: ${store.scannedAt ?? (locale.value === "zh-CN" ? "尚无" : "None")}`,
    `${locale.value === "zh-CN" ? "扫描耗时" : "Scan duration"}: ${store.scanDurationMs} ms`,
    `${locale.value === "zh-CN" ? "显示/命中/总计" : "Shown/matched/total"}: ${store.viewEntries.length}/${store.filteredEntries.length}/${store.totalCount}`,
    `${locale.value === "zh-CN" ? "权限受限条目" : "Access-restricted rows"}: ${store.entries.filter((entry) => entry.process_status === "AccessDenied").length}`,
    `${locale.value === "zh-CN" ? "部分失败范围" : "Partial failures"}: ${store.scanIssues.length}`,
  ].join("\n"),
);

async function copyDiagnostic() {
  try {
    await navigator.clipboard.writeText(diagnostic.value);
    store.notify(
      "success",
      locale.value === "zh-CN" ? "诊断摘要已复制" : "Diagnostic summary copied",
    );
  } catch (error) {
    store.notify(
      "error",
      locale.value === "zh-CN"
        ? `复制诊断摘要失败：${error instanceof Error ? error.message : String(error)}`
        : `Failed to copy diagnostic summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
</script>

<template>
  <Dialog
    v-model:visible="store.aboutVisible"
    modal
    :header="locale === 'zh-CN' ? '关于与诊断' : 'About & diagnostics'"
    :style="{ width: '520px', maxWidth: 'calc(100vw - 24px)' }"
  >
    <div class="about-dialog">
      <div class="about-title">
        <span class="brand-mark" aria-hidden="true">PV</span>
        <div>
          <b>PortViewer {{ PRODUCT_VERSION }}</b
          ><small>{{
            locale === "zh-CN"
              ? "轻量本机端口检查器"
              : "Lightweight local port inspector"
          }}</small>
        </div>
      </div>
      <p>
        {{
          locale === "zh-CN"
            ? "扫描结果只保存在内存中；应用默认不联网，不保存端口或进程历史。"
            : "Scan results remain in memory; by default the app makes no network requests and stores no port or process history."
        }}
      </p>
      <pre>{{ diagnostic }}</pre>
    </div>
    <template #footer>
      <button @click="copyDiagnostic">
        {{ locale === "zh-CN" ? "复制诊断摘要" : "Copy diagnostic summary" }}
      </button>
      <button class="primary-btn" @click="store.aboutVisible = false">
        {{ locale === "zh-CN" ? "关闭" : "Close" }}
      </button>
    </template>
  </Dialog>
</template>

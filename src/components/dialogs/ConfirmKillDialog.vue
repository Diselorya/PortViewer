<script setup lang="ts">
import Dialog from "primevue/dialog";
import { useAppStore } from "../../stores/app";
import { useI18n } from "../../i18n";
const store = useAppStore();
const { locale } = useI18n();
async function copyError() {
  try {
    if (store.killError) await navigator.clipboard.writeText(store.killError);
    store.notify(
      "info",
      locale.value === "zh-CN" ? "错误信息已复制" : "Error copied",
    );
  } catch (error) {
    store.notify(
      "error",
      locale.value === "zh-CN"
        ? `复制错误信息失败：${error instanceof Error ? error.message : String(error)}`
        : `Failed to copy error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
</script>
<template>
  <Dialog
    v-model:visible="store.killVisible"
    modal
    :header="locale === 'zh-CN' ? '终止进程？' : 'Terminate process?'"
    :style="{ width: '480px' }"
    :closable="!store.killBusy"
    ><div v-if="store.killTarget" class="kill-dialog">
      <p class="danger-callout">
        <b
          >{{
            locale === "zh-CN" ? "这会立即关闭" : "This will immediately close"
          }}
          {{ store.killTarget.process_name }}</b
        >
        {{ locale === "zh-CN" ? "及其" : "and its" }}
        {{ store.killTargetEndpointCount }}
        {{
          locale === "zh-CN"
            ? "个网络端点，未保存的数据可能丢失。"
            : "network endpoints. Unsaved data may be lost."
        }}
      </p>
      <dl>
        <dt>{{ locale === "zh-CN" ? "进程" : "Process" }}</dt>
        <dd>{{ store.killTarget.process_name }}</dd>
        <dt>PID</dt>
        <dd class="mono">{{ store.killTarget.pid }}</dd>
        <dt>{{ locale === "zh-CN" ? "路径" : "Path" }}</dt>
        <dd class="mono path">
          {{
            store.killTarget.process_path ||
            (locale === "zh-CN" ? "未获取" : "Unavailable")
          }}
        </dd>
        <dt>{{ locale === "zh-CN" ? "创建时间" : "Created" }}</dt>
        <dd class="mono">{{ store.killTarget.process_created_at }}</dd>
      </dl>
      <div v-if="store.killError" class="inline-error" role="alert">
        <b>{{
          locale === "zh-CN" ? "未能终止进程" : "Failed to terminate process"
        }}</b
        ><span>{{ store.killError }}</span
        ><button @click="copyError()">
          {{ locale === "zh-CN" ? "复制错误" : "Copy error" }}
        </button>
      </div>
    </div>
    <template #footer
      ><button
        autofocus
        :disabled="store.killBusy"
        @click="store.killVisible = false"
      >
        {{ locale === "zh-CN" ? "取消" : "Cancel" }}</button
      ><button
        class="danger-btn"
        :disabled="store.killBusy"
        @click="store.killSelected"
      >
        {{
          store.killBusy
            ? locale === "zh-CN"
              ? "正在终止…"
              : "Terminating…"
            : locale === "zh-CN"
              ? "终止进程"
              : "Terminate"
        }}
      </button></template
    ></Dialog
  >
</template>

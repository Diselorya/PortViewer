<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <main class="build-identity-error" role="alert">
    <section>
      <div class="brand-mark" aria-hidden="true">PV</div>
      <h1>PortViewer 无法启动</h1>
      <p>检测到前端与后端不属于同一次可信构建，已阻止继续运行。</p>
      <code>{{ message }}</code>
      <p class="hint">
        请关闭当前程序，并使用 <b>npm run build:desktop</b> 重新生成可执行文件。
      </p>
    </section>
  </main>
</template>

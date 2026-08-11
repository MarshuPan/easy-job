<script lang="ts" setup>
import { AgentButton, AgentDialog } from '@/ui/instrument'

const show = defineModel<boolean>({ required: true })
</script>

<template>
  <AgentDialog
    v-model="show"
    title="账户配置"
    width="520px"
    align-center
    destroy-on-close
    :z-index="2147483200"
  >
    <section class="account-security-notice" data-test="account-management-disabled">
      <strong>安全策略已停用浏览器 Cookie 账号管理</strong>
      <p>
        当前页面运行在网站上下文中，不能读取、保存或修改扩展持有的账号凭据。已有账号数据不会从页面侧加载或改写。
      </p>
    </section>
    <template #footer>
      <AgentButton @click="show = false">关闭</AgentButton>
    </template>
  </AgentDialog>
</template>

<style lang="scss" scoped>
.account-security-notice {
  padding: 16px;
  border: 1px solid var(--agent-border);
  border-radius: 6px;
  color: var(--agent-text);
  background: var(--agent-surface-soft);
}

.account-security-notice p {
  margin: 8px 0 0;
  line-height: 1.6;
  color: var(--agent-text-regular);
}
</style>

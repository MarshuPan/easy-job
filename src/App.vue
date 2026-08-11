<script lang="ts" setup>
import { ref } from 'vue'

import userVue from '@/components/conf/User.vue'
import { AgentTooltip } from '@/ui/instrument'

const confBox = ref(false)
</script>

<template>
  <AgentTooltip content="账号配置" placement="left">
    <button class="agent-delivery-menu-trigger" type="button" @click="confBox = true">账号</button>
  </AgentTooltip>
  <Teleport to="body">
    <userVue id="help-conf-box" v-model="confBox" />
  </Teleport>
</template>

<style lang="scss">
.agent-delivery-menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--agent-border, #d8e6ff);
  border-radius: 50%;
  color: var(--agent-primary, #3f7ff5);
  background: var(--agent-surface, #ffffff);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--agent-shadow-soft, 0 8px 22px rgb(31 86 168 / 10%));
}

.store-item-a {
  .store-item {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-direction: column;
    width: 140px;
    height: 180px;
    background: var(--agent-primary-soft, #eaf3ff);
    padding: 10px;
    border: 1px solid var(--agent-border, #d8e6ff);
    border-radius: 12px;
    background-color: var(--agent-bg-soft, #f8fbff);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.04),
      0 1px 2px rgba(0, 0, 0, 0.06);
    transition:
      border-color 0.25s,
      background-color 0.25s;
  }
  &:hover {
    .store-item {
      background-color: var(--agent-primary-soft, #eaf3ff);
      border-color: var(--agent-primary, #3f7ff5);
    }
  }
}
</style>

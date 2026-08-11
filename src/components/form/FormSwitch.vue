<script lang="ts" setup>
import settingsVue from '@/components/icon/Settings.vue'
import type { FormDataAi } from '@/types/formData'
import { AgentButton, AgentSwitch } from '@/ui/instrument'

defineProps<{
  label: string
  lock?: boolean
  help?: string
  disabled?: boolean
  data: Partial<FormDataAi>
}>()

defineEmits<{
  (e: 'change', data: Partial<FormDataAi>): void
  (e: 'show'): void
}>()
</script>

<template>
  <div class="form-switch">
    <div class="form-switch__main">
      <span class="form-switch__label">{{ label }}</span>
      <AgentSwitch
        :model-value="Boolean(data.enable)"
        :disabled="lock || disabled"
        @change="$emit('change', data)"
      />
    </div>
    <AgentButton size="small" :icon="settingsVue" :disabled @click="$emit('show')"
      >编辑</AgentButton
    >
  </div>
</template>

<style lang="scss" scoped>
.form-switch {
  min-width: 220px;
  border: 1px solid var(--agent-border);
  border-radius: 0;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--agent-surface);
}

.form-switch__main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-switch__label {
  font-weight: 600;
  color: var(--agent-text-regular);
}
</style>

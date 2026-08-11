<script lang="ts" setup>
import { AgentCheckbox, AgentFormItem, AgentLink } from '@/ui/instrument'

defineProps<{
  label: string
  help?: string
  disabled?: boolean
}>()

const include = defineModel<boolean | undefined>('include', {
  default: undefined,
})
const enable = defineModel<boolean>('enable', { required: true })
</script>

<template>
  <AgentFormItem>
    <template #label>
      <AgentCheckbox v-model="enable" :label size="small" />
      <slot name="include">
        <AgentLink
          v-if="include != null"
          :type="include ? 'primary' : 'warning'"
          size="small"
          :disabled
          @click.stop="include = !include"
        >
          {{ include ? '包含' : '排除' }}
        </AgentLink>
      </slot>
    </template>
    <slot />
  </AgentFormItem>
</template>

<style lang="scss" scoped></style>

<script setup lang="ts">
import { computed, useAttrs } from 'vue'

import { cn } from './cn'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    size?: 'sm' | 'md'
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    disabled: false,
    type: 'button',
  },
)

const attrs = useAttrs()

const buttonAttrs = computed(() =>
  Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'class')),
)

const buttonClass = computed(() =>
  cn(
    'inline-flex items-center justify-center rounded-md border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-bh-primary focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
    props.size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
    props.variant === 'primary' && 'border-bh-primary bg-bh-primary text-white hover:brightness-95',
    props.variant === 'secondary' &&
      'border-bh-border bg-bh-surface text-bh-text hover:bg-slate-50',
    props.variant === 'danger' && 'border-bh-danger bg-bh-danger text-white hover:brightness-95',
    props.variant === 'ghost' &&
      'border-transparent bg-transparent text-bh-text hover:bg-slate-100',
    attrs.class as Parameters<typeof cn>[number],
  ),
)
</script>

<template>
  <button v-bind="buttonAttrs" :type="props.type" :disabled="props.disabled" :class="buttonClass">
    <slot />
  </button>
</template>

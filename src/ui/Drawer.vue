<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

import Button from './Button.vue'

defineProps<{
  title: string
}>()

const open = defineModel<boolean>({ required: true })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[2147483640] bg-black/30" />
      <DialogContent
        class="fixed right-0 top-0 z-[2147483641] h-dvh w-[min(720px,92vw)] overflow-auto border-l border-bh-border bg-bh-surface p-5 shadow-xl"
        style="
          background: linear-gradient(180deg, var(--agent-surface), var(--agent-bg-soft));
          box-shadow: var(--agent-shadow);
        "
      >
        <header class="mb-4 flex items-center justify-between gap-3">
          <DialogTitle class="text-base font-semibold text-bh-text">
            {{ title }}
          </DialogTitle>

          <DialogClose as-child>
            <Button variant="ghost" size="sm">关闭</Button>
          </DialogClose>
        </header>

        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script lang="ts" setup>
import { useStorageAsync } from '@vueuse/core'
import { watch } from 'vue'

import { ExtStorage } from '@/message'
import { AgentCheckbox } from '@/ui/instrument'

const conf = useStorageAsync(
  'appearance-conf',
  {
    hideHeader: false,
    listSink: false,
  },
  ExtStorage,
  { mergeDefaults: true },
)

watch(
  () => conf.value.hideHeader,
  (val) => {
    const h = document.getElementById('header')
    if (!h) return
    h.style.display = val ? 'none' : ''
  },
)

watch(
  () => conf.value.listSink,
  (val) => {
    const h = document.getElementById('agent-delivery-job-warp')
    if (!h) return
    h.style.marginBottom = val ? '300px' : 'unset'
  },
)
</script>

<template>
  <div class="appearance-actions">
    <AgentCheckbox v-model="conf.hideHeader" label="隐藏头" border />
    <AgentCheckbox v-model="conf.listSink" label="列表下沉" border />
  </div>
</template>

<style lang="scss" scoped>
.appearance-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
</style>

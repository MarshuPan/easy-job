<script lang="ts" setup>
import formSwitch from '@/components/form/FormSwitch.vue'
import { useCommon } from '@/composables/useCommon'
import { formInfoData, useConf } from '@/stores/conf'
import type { FormDataAi } from '@/types/formData'
import { AgentSpace } from '@/ui/instrument'

const conf = useConf()
const { deliverLock } = useCommon()
function change(v: Partial<FormDataAi>) {
  v.enable = !v.enable
  conf.confSaving()
}
</script>

<template>
  <AgentSpace wrap fill :fill-ratio="32" style="width: 100%">
    <formSwitch
      :label="formInfoData.aiGreeting.label"
      :data="conf.formData.aiGreeting"
      :lock="deliverLock"
      @change="change"
    />
    <formSwitch
      :label="formInfoData.aiFiltering.label"
      :data="conf.formData.aiFiltering"
      :lock="deliverLock"
      @change="change"
    />
  </AgentSpace>
</template>

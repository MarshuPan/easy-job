<script lang="ts" setup>
withDefaults(
  defineProps<{
    title: string
    description?: string
  }>(),
  {
    description: '',
  },
)
</script>

<template>
  <div class="instrument-empty-state" role="status">
    <span class="instrument-empty-state__mark" aria-hidden="true">
      <slot name="icon" />
    </span>
    <strong>{{ title }}</strong>
    <span v-if="description">{{ description }}</span>
  </div>
</template>

<style scoped>
.instrument-empty-state {
  display: grid;
  min-height: 220px;
  place-content: center;
  justify-items: center;
  gap: 7px;
  color: var(--agent-muted);
  text-align: center;
}

.instrument-empty-state__mark {
  display: grid;
  width: 42px;
  height: 42px;
  margin-bottom: 3px;
  place-items: center;
  border: 1px solid var(--agent-border);
  color: var(--agent-muted-soft);
  background: #f1f2f1;
}

.instrument-empty-state strong {
  color: var(--agent-text-regular);
  font-size: 12px;
  font-weight: 600;
}

.instrument-empty-state > span:last-child:not(.instrument-empty-state__mark) {
  max-width: 280px;
  font-size: 11px;
  line-height: 1.5;
}
</style>

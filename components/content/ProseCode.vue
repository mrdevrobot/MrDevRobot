<template>
  <div class="code-block">
    <div class="code-block__header">
      <span class="code-block__dots" aria-hidden="true"><i /><i /><i /></span>
      <span class="code-block__lang">{{ filename || language || 'code' }}</span>
      <button
        class="code-block__copy"
        :class="{ 'code-block__copy--done': copied }"
        :aria-label="copied ? 'Copied' : 'Copy code'"
        @click="handleCopy"
      >
        <svg v-if="!copied" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
        <span>{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  code?: string
  language?: string
  filename?: string
  highlights?: number[]
}>()

const copied = ref(false)

async function handleCopy() {
  if (!props.code) return
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {}
}
</script>

<style scoped>
.code-block {
  position: relative;
  margin: 1.5rem 0 1.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--code-bg);
  box-shadow: var(--shadow);
}

.code-block__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--code-head);
  padding: 0.5rem 0.75rem 0.5rem 0.9rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  user-select: none;
}

.code-block__dots {
  display: inline-flex;
  gap: 5px;
}

.code-block__dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
}

.code-block__lang {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: #8b96ab;
  letter-spacing: 0.04em;
}

.code-block__copy {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 500;
  color: #c3cbd9;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 0.25rem 0.6rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
}

.code-block__copy svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.code-block__copy:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.18);
  color: #fff;
}

.code-block__copy--done {
  color: #22d3ee;
  border-color: rgba(34, 211, 238, 0.4);
}

/* Code blocks stay dark in both themes: use Shiki's dark palette regardless */
.code-block :deep(pre) {
  background-color: transparent !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 1.1rem 1.3rem !important;
  font-size: 0.84rem !important;
  line-height: 1.7 !important;
  overflow-x: auto;
  tab-size: 2;
  font-family: var(--font-mono);
}

.code-block :deep(pre code) {
  background: transparent !important;
  border: none !important;
  padding: 0 !important;
  font-size: inherit !important;
  font-family: inherit !important;
}

.code-block :deep(pre code .line) {
  display: block;
}

.code-block :deep(pre code span) {
  color: var(--shiki-dark, var(--shiki-default));
  font-family: inherit;
}

.code-block :deep(pre::-webkit-scrollbar) {
  height: 6px;
}

.code-block :deep(pre::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.14);
  border: none;
}
</style>

<template>
  <div class="code-block">
    <div class="code-block__header">
      <span class="code-block__lang">{{ language || 'code' }}</span>
      <button
        class="code-block__copy"
        :class="{ 'code-block__copy--done': copied }"
        :aria-label="copied ? 'Copied' : 'Copy code'"
        @click="handleCopy"
      >{{ copied ? '✓ copied' : '> copy' }}</button>
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
  margin-bottom: 1.75rem;
  border-left: 3px solid #4ade80;
  border-top: 1px solid #1e2d1e;
  border-right: 1px solid #1e2d1e;
  border-bottom: 1px solid #1e2d1e;
  border-radius: 0 4px 4px 0;
  overflow: hidden;
  box-shadow: 0 2px 20px rgba(0, 0, 0, 0.22), -2px 0 12px rgba(74, 222, 128, 0.06);
}

/* ── Header bar ── */
.code-block__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #080a08;
  padding: 0.38rem 1rem;
  border-bottom: 1px solid #1a2c1a;
  gap: 1rem;
  user-select: none;
}

.code-block__lang {
  font-family: 'Space Mono', monospace;
  font-size: 0.62rem;
  color: #4ade80;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.75;
}

.code-block__copy {
  font-family: 'Space Mono', monospace;
  font-size: 0.62rem;
  color: #4ade80;
  background: transparent;
  border: 1px solid #2a4a2a;
  padding: 0.17rem 0.6rem;
  cursor: pointer;
  letter-spacing: 0.05em;
  transition: all 0.15s ease;
  opacity: 0.55;
  border-radius: 2px;
  line-height: 1.4;
}

.code-block__copy:hover {
  opacity: 1;
  background: rgba(74, 222, 128, 0.07);
  border-color: #4ade80;
}

.code-block__copy--done {
  opacity: 1;
  color: #86efac;
  border-color: #4ade80;
}

/* ── pre/code inside slot ── */
/* Force our terminal background regardless of Shiki's inline style */
.code-block :deep(pre) {
  background-color: #0c0e0c !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 1.1rem 1.3rem !important;
  font-size: 0.84rem !important;
  line-height: 1.72 !important;
  overflow-x: auto;
  tab-size: 2;
  font-family: 'Space Mono', monospace;
}

.code-block :deep(pre code) {
  background: transparent !important;
  border: none !important;
  padding: 0 !important;
  font-size: inherit !important;
  font-family: inherit !important;
  counter-reset: line;
}

/* Shiki token spans — let their colors through */
.code-block :deep(pre code .line) {
  display: block;
}

/* Activate CSS-variables color mode that @nuxt/content uses */
.code-block :deep(pre code span) {
  color: var(--shiki-default);
  font-family: inherit;
}

/* ── Custom scrollbar ── */
.code-block :deep(pre::-webkit-scrollbar) {
  height: 5px;
}

.code-block :deep(pre::-webkit-scrollbar-track) {
  background: #0c0e0c;
}

.code-block :deep(pre::-webkit-scrollbar-thumb) {
  background: #2a4a2a;
  border-radius: 3px;
}

.code-block :deep(pre::-webkit-scrollbar-thumb:hover) {
  background: #4ade80;
}
</style>

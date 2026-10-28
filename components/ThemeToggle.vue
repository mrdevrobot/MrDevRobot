<template>
  <button
    class="theme-toggle"
    type="button"
    :aria-label="$t('nav.toggleTheme')"
    :title="$t('nav.toggleTheme')"
    @click="toggle"
  >
    <span class="theme-toggle__track">
      <span class="theme-toggle__thumb">
        <svg class="theme-toggle__icon theme-toggle__icon--sun" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <svg class="theme-toggle__icon theme-toggle__icon--moon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      </span>
    </span>
  </button>
</template>

<script setup lang="ts">
function toggle() {
  const root = document.documentElement
  const next = root.dataset.theme === 'light' ? 'dark' : 'light'
  root.dataset.theme = next
  try { localStorage.setItem('theme', next) } catch {}
}
</script>

<style scoped>
.theme-toggle {
  background: transparent;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  border-radius: var(--radius-pill);
}

.theme-toggle__track {
  display: block;
  width: 44px;
  height: 24px;
  border-radius: var(--radius-pill);
  background: var(--surface);
  border: 1px solid var(--border);
  position: relative;
  transition: background var(--t-fast), border-color var(--t-fast);
}

.theme-toggle:hover .theme-toggle__track {
  border-color: var(--border-strong);
}

.theme-toggle__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--text);
  display: grid;
  place-items: center;
  transition: transform var(--t-med), background var(--t-fast);
}

:root[data-theme='light'] .theme-toggle__thumb {
  transform: translateX(20px);
}

.theme-toggle__icon {
  position: absolute;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--bg);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: opacity var(--t-fast), transform var(--t-med);
}

.theme-toggle__icon--sun {
  opacity: 0;
  transform: rotate(-90deg) scale(0.6);
}

:root[data-theme='light'] .theme-toggle__icon--sun {
  opacity: 1;
  transform: none;
}

:root[data-theme='light'] .theme-toggle__icon--moon {
  opacity: 0;
  transform: rotate(90deg) scale(0.6);
}
</style>

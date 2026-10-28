<template>
  <div class="language-switcher" role="group" :aria-label="$t('nav.language')">
    <NuxtLink
      v-for="locale in availableLocales"
      :key="locale.code"
      :to="switchLocalePath(locale.code)"
      class="language-switcher__btn"
      :class="{ 'language-switcher__btn--active': locale.code === currentLocale }"
      :aria-current="locale.code === currentLocale ? 'true' : undefined"
    >
      {{ locale.code.toUpperCase() }}
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
const { locale, locales } = useI18n()
const switchLocalePath = useSwitchLocalePath()

const currentLocale = computed(() => locale.value)

const availableLocales = computed(() =>
  (locales.value as Array<{ code: string; name: string }>)
)
</script>

<style scoped>
.language-switcher {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: var(--radius-pill);
  background: var(--surface);
  border: 1px solid var(--border);
}

.language-switcher__btn {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.55rem;
  border-radius: var(--radius-pill);
  color: var(--text-3);
  text-decoration: none;
  transition: color var(--t-fast), background var(--t-fast);
}

.language-switcher__btn:hover {
  color: var(--text);
}

.language-switcher__btn--active {
  color: var(--text);
  background: var(--bg-elev);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
</style>

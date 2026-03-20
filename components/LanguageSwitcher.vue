<template>
  <div class="language-switcher">
    <NuxtLink
      v-for="locale in availableLocales"
      :key="locale.code"
      :to="switchLocalePath(locale.code)"
      class="language-switcher__btn"
      :class="{ 'language-switcher__btn--active': locale.code === currentLocale }"
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
  display: flex;
  gap: 0.2rem;
  align-items: center;
}

.language-switcher__btn {
  font-family: 'Space Mono', monospace;
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 0.2rem 0.45rem;
  color: #4ade80;
  opacity: 0.45;
  text-decoration: none;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.language-switcher__btn:hover {
  opacity: 0.9;
  border-color: rgba(74, 222, 128, 0.3);
}

.language-switcher__btn--active {
  opacity: 1;
  border-color: rgba(74, 222, 128, 0.45);
}
</style>

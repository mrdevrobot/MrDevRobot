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
  gap: 0.25rem;
  align-items: center;
}

.language-switcher__btn {
  padding: 0.25rem 0.6rem;
  border-radius: 0.375rem;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: #6b7280;
  text-decoration: none;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.language-switcher__btn:hover {
  color: #16a34a;
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.language-switcher__btn--active {
  color: #16a34a;
  background: #f0fdf4;
  border-color: #86efac;
}
</style>

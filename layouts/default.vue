<template>
  <div class="site-wrapper">
    <header class="site-header">
      <div class="container site-header__inner">
        <NuxtLink :to="localePath('/')" class="site-header__logo">
          <span class="logo-caret">&gt;</span>&nbsp;MrDevRobot
        </NuxtLink>
        <nav class="site-header__nav">
          <NuxtLink :to="localePath('/')" class="site-header__nav-link">
            {{ $t('nav.home') }}
          </NuxtLink>
          <NuxtLink :to="localePath('/blog')" class="site-header__nav-link">
            {{ $t('nav.blog') }}
          </NuxtLink>
        </nav>
        <LanguageSwitcher />
      </div>
    </header>

    <main class="site-main">
      <slot />
    </main>

    <footer class="site-footer">
      <div class="container site-footer__inner">
        <span>{{ $t('footer.text', { year: new Date().getFullYear() }) }}</span>
        <span class="site-footer__sep">//</span>
        <span>{{ $t('footer.tagline') }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
const localePath = useLocalePath()

// Adds lang attribute, canonical, hreflang alternate links for all locales
const i18nHead = useLocaleHead({ addSeoAttributes: true })
useHead(() => ({
  htmlAttrs: { lang: i18nHead.value.htmlAttrs?.lang },
  link: i18nHead.value.link ?? [],
  meta: i18nHead.value.meta ?? []
}))
</script>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  background: #f5f3e8;
  color: #1c1917;
  line-height: 1.6;
}

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 1.25rem;
}

a {
  color: inherit;
}

img {
  max-width: 100%;
}
</style>

<style scoped>
.site-wrapper {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ── Header ── */
.site-header {
  background: #0c0e0c;
  border-bottom: 1px solid rgba(74, 222, 128, 0.12);
  position: sticky;
  top: 0;
  z-index: 100;
}

.site-header__inner {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  height: 52px;
}

.site-header__logo {
  font-family: 'Space Mono', monospace;
  font-size: 0.95rem;
  font-weight: 700;
  color: #4ade80;
  text-decoration: none;
  flex-shrink: 0;
  text-shadow: 0 0 10px rgba(74, 222, 128, 0.35);
  letter-spacing: -0.01em;
}

.logo-caret {
  color: #22c55e;
  opacity: 0.5;
}

.site-header__nav {
  display: flex;
  gap: 1.5rem;
  flex: 1;
}

.site-header__nav-link {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #4ade80;
  opacity: 0.5;
  text-decoration: none;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  transition: opacity 0.15s ease, text-shadow 0.15s ease;
}

.site-header__nav-link:hover,
.site-header__nav-link.router-link-active {
  opacity: 1;
  text-shadow: 0 0 8px rgba(74, 222, 128, 0.45);
}

/* ── Main ── */
.site-main {
  flex: 1;
}

/* ── Footer ── */
.site-footer {
  background: #0c0e0c;
  border-top: 1px solid rgba(74, 222, 128, 0.12);
  padding: 0.875rem 0;
}

.site-footer__inner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  font-family: 'Space Mono', monospace;
  font-size: 0.67rem;
  color: #4ade80;
  opacity: 0.4;
  letter-spacing: 0.02em;
}

.site-footer__sep {
  opacity: 0.5;
}
</style>

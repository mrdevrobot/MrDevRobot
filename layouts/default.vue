<template>
  <div class="site-wrapper">
    <header class="site-header">
      <div class="site-header__inner container">
        <NuxtLink :to="localePath('/')" class="site-header__logo">
          MrDevRobot
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
      <div class="container">
        <p>{{ $t('footer.text', { year: new Date().getFullYear() }) }}</p>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
const localePath = useLocalePath()
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
  background: #f9fafb;
  color: #111827;
  line-height: 1.6;
}

.container {
  max-width: 900px;
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
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 100;
}

.site-header__inner {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  height: 64px;
}

.site-header__logo {
  font-size: 1.25rem;
  font-weight: 800;
  color: #16a34a;
  text-decoration: none;
  letter-spacing: -0.02em;
  flex-shrink: 0;
}

.site-header__nav {
  display: flex;
  gap: 1.25rem;
  flex: 1;
}

.site-header__nav-link {
  font-size: 0.95rem;
  font-weight: 500;
  color: #374151;
  text-decoration: none;
  transition: color 0.15s ease;
}

.site-header__nav-link:hover,
.site-header__nav-link.router-link-active {
  color: #16a34a;
}

/* ── Main ── */
.site-main {
  flex: 1;
  padding: 2.5rem 0;
}

/* ── Footer ── */
.site-footer {
  background: #fff;
  border-top: 1px solid #e5e7eb;
  padding: 1.25rem 0;
  text-align: center;
  font-size: 0.875rem;
  color: #6b7280;
}
</style>

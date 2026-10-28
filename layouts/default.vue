<template>
  <div class="site-wrapper">
    <div class="backdrop" aria-hidden="true">
      <div class="backdrop__glow backdrop__glow--a" />
      <div class="backdrop__glow backdrop__glow--b" />
      <div class="backdrop__grid" />
    </div>

    <header class="site-header">
      <div class="container site-header__inner">
        <NuxtLink :to="localePath('/')" class="site-header__logo" aria-label="MrDevRobot">
          <span class="site-header__mark" aria-hidden="true" />
          <span>MrDevRobot</span>
        </NuxtLink>

        <nav class="site-header__nav" :aria-label="$t('nav.main')">
          <NuxtLink :to="localePath('/')" class="site-header__nav-link">
            {{ $t('nav.home') }}
          </NuxtLink>
          <NuxtLink :to="localePath('/blog')" class="site-header__nav-link">
            {{ $t('nav.blog') }}
          </NuxtLink>
          <a href="https://github.com/mrdevrobot" target="_blank" rel="noopener" class="site-header__nav-link site-header__nav-link--ext">
            GitHub
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
          </a>
        </nav>

        <div class="site-header__tools">
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </div>
    </header>

    <main class="site-main">
      <slot />
    </main>

    <footer class="site-footer">
      <div class="container site-footer__inner">
        <span class="site-footer__copy">{{ $t('footer.text', { year: new Date().getFullYear() }) }}</span>
        <span class="site-footer__tagline">{{ $t('footer.tagline') }}</span>
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

<style scoped>
.site-wrapper {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  position: relative;
  isolation: isolate;
}

/* ── Ambient backdrop ── */
.backdrop {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}

.backdrop__grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--grid-dot) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 20%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 20%, transparent 75%);
}

.backdrop__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.9;
}

.backdrop__glow--a {
  width: 60vw;
  height: 60vw;
  max-width: 820px;
  max-height: 820px;
  top: -30vw;
  left: -12vw;
  background: radial-gradient(circle, var(--glow-1), transparent 65%);
}

.backdrop__glow--b {
  width: 50vw;
  height: 50vw;
  max-width: 700px;
  max-height: 700px;
  top: -18vw;
  right: -14vw;
  background: radial-gradient(circle, var(--glow-2), transparent 65%);
}

@media (prefers-reduced-motion: no-preference) {
  .backdrop__glow--a { animation: drift 26s ease-in-out infinite alternate; }
  .backdrop__glow--b { animation: drift 32s ease-in-out infinite alternate-reverse; }
}

@keyframes drift {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(6vw, 4vw, 0); }
}

/* ── Header ── */
.site-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--glass);
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  border-bottom: 1px solid var(--border);
}

.site-header__inner {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  height: var(--header-h);
}

.site-header__logo {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: -0.02em;
  text-decoration: none;
  color: var(--text);
  flex-shrink: 0;
}

.site-header__mark {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 14px var(--glow-1);
  transform: rotate(45deg);
  transition: transform var(--t-med);
}

.site-header__logo:hover .site-header__mark {
  transform: rotate(135deg);
}

.site-header__nav {
  display: flex;
  gap: 0.25rem;
  flex: 1;
}

.site-header__nav-link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-2);
  text-decoration: none;
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-pill);
  transition: color var(--t-fast), background var(--t-fast);
}

.site-header__nav-link:hover {
  color: var(--text);
  background: var(--surface);
}

.site-header__nav-link.router-link-exact-active {
  color: var(--text);
  background: var(--surface-hover);
}

.site-header__nav-link svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.6;
}

.site-header__tools {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-left: auto;
}

@media (max-width: 600px) {
  .site-header__inner { gap: 0.75rem; }
  .site-header__logo span:last-child { display: none; }
  .site-header__nav-link--ext { display: none; }
}

/* ── Main ── */
.site-main {
  flex: 1;
}

/* ── Footer ── */
.site-footer {
  border-top: 1px solid var(--border);
  padding: 1.5rem 0 calc(1.5rem + env(safe-area-inset-bottom));
}

.site-footer__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1.5rem;
  flex-wrap: wrap;
  font-size: 0.8rem;
  color: var(--text-3);
}
</style>

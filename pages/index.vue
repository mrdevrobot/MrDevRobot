<template>
  <div>
    <!-- Hero -->
    <section class="hero">
      <div class="container hero__inner">
        <p class="eyebrow hero__eyebrow">{{ $t('hero.eyebrow') }}</p>
        <h1 class="hero__title">
          <span class="hero__name">Luca Fabbri</span>
          <span class="hero__headline gradient-text">{{ $t('hero.headline') }}</span>
        </h1>
        <p class="hero__lead">{{ $t('hero.lead') }}</p>
        <div class="hero__actions">
          <NuxtLink :to="localePath('/blog')" class="btn btn--primary">
            {{ $t('hero.cta') }}
            <svg class="btn__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </NuxtLink>
          <a href="https://github.com/mrdevrobot" target="_blank" rel="noopener" class="btn btn--ghost">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="btn__gh"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.4-1.1-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z" /></svg>
            {{ $t('hero.github') }}
          </a>
        </div>
        <ul class="hero__facts" aria-label="Facts">
          <li v-for="fact in facts" :key="fact.label">
            <span class="hero__fact-value">{{ fact.value }}</span>
            <span class="hero__fact-label">{{ fact.label }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- About / bento -->
    <section class="about">
      <div class="container">
        <div class="bento">
          <div class="card bento__about reveal">
            <img src="/avatar.jpg" alt="Luca Fabbri" class="bento__avatar" width="88" height="88" loading="lazy">
            <h2 class="section-title bento__title">{{ $t('about.title') }}</h2>
            <p class="bento__text">{{ $t('about.intro') }}</p>
            <p class="bento__text">{{ $t('about.expertise') }}</p>
            <div class="bento__tags">
              <span v-for="skill in skills" :key="skill" class="tag">{{ skill }}</span>
            </div>
          </div>

          <a href="https://xedotnet.org" target="_blank" rel="noopener" class="card card--hover card--glow bento__tile reveal">
            <span class="bento__tile-kicker">{{ $t('about.community') }}</span>
            <span class="bento__tile-title">XeDotNet</span>
            <span class="bento__tile-text">{{ $t('about.xedotnet') }}</span>
            <span class="bento__tile-arrow" aria-hidden="true">↗</span>
          </a>

          <NuxtLink :to="localePath('/blog')" class="card card--hover card--glow bento__tile reveal">
            <span class="bento__tile-kicker">{{ $t('nav.blog') }}</span>
            <span class="bento__tile-title">{{ $t('about.blogTitle') }}</span>
            <span class="bento__tile-text">{{ $t('about.blog_description') }}</span>
            <span class="bento__tile-arrow" aria-hidden="true">→</span>
          </NuxtLink>
        </div>
      </div>
    </section>

    <!-- Open source -->
    <section class="projects">
      <div class="container">
        <div class="section-head reveal">
          <h2 class="section-title">{{ $t('about.opensource') }}</h2>
          <a href="https://github.com/mrdevrobot" target="_blank" rel="noopener" class="section-link">
            {{ $t('about.allProjects') }} <span aria-hidden="true">→</span>
          </a>
        </div>
        <ul class="projects__grid">
          <li v-for="proj in projects" :key="proj.name" class="reveal">
            <a :href="proj.url" target="_blank" rel="noopener" class="card card--hover card--glow project">
              <span class="project__icon" aria-hidden="true">{{ proj.name.slice(0, 1) }}</span>
              <span class="project__name">{{ proj.name }}</span>
              <span class="project__desc">{{ proj.desc }}</span>
              <span class="project__meta mono">{{ proj.meta }}</span>
            </a>
          </li>
        </ul>
      </div>
    </section>

    <!-- Latest Articles -->
    <section class="latest">
      <div class="container">
        <div class="section-head reveal">
          <h2 class="section-title">{{ $t('article.latestArticles') }}</h2>
          <NuxtLink :to="localePath('/blog')" class="section-link">
            {{ $t('article.allArticles') }} <span aria-hidden="true">→</span>
          </NuxtLink>
        </div>
        <div v-if="articles && articles.length" class="articles-grid">
          <ArticleCard
            v-for="article in articles"
            :key="article._path"
            :article="article"
          />
        </div>
        <p v-else class="no-articles">{{ $t('article.noArticles') }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
const { locale, t } = useI18n()
const localePath = useLocalePath()
const siteUrl = 'https://mrdevrobot.com'

const { data: articles } = await useAsyncData(
  `home-articles-${locale.value}`,
  () => queryContent(`/${locale.value}/blog`)
    .where({ date: { $lte: new Date().toISOString().split('T')[0] } })
    .sort({ date: -1 })
    .limit(3)
    .find()
)

useSeoMeta({
  title: 'Luca Fabbri',
  description: () => t('seo.homeDescription'),
  ogTitle: 'Luca Fabbri · MrDevRobot',
  ogDescription: () => t('seo.homeDescription'),
  ogImage: `${siteUrl}/luca-fabbri.jpg`,
  ogImageAlt: 'Luca Fabbri — R&D and AI Expert & .NET Engineer',
  ogType: 'website',
  ogUrl: () => locale.value === 'en' ? siteUrl : `${siteUrl}/${locale.value}`,
  twitterTitle: 'Luca Fabbri · MrDevRobot',
  twitterDescription: () => t('seo.homeDescription'),
  twitterImage: `${siteUrl}/luca-fabbri.jpg`,
  robots: 'index, follow'
})

useHead({
  script: [{
    type: 'application/ld+json',
    innerHTML: () => JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Person',
          '@id': `${siteUrl}/#person`,
          name: 'Luca Fabbri',
          url: siteUrl,
          image: { '@type': 'ImageObject', url: `${siteUrl}/luca-fabbri.jpg` },
          jobTitle: 'R&D and AI Expert',
          birthPlace: { '@type': 'Place', name: 'Rimini, Italy' },
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Noventa di Piave',
            addressRegion: 'Veneto',
            addressCountry: 'IT'
          },
          sameAs: ['https://github.com/mrdevrobot', 'https://xedotnet.org'],
          knowsAbout: ['.NET', 'Clean Architecture', 'Domain-Driven Design', 'Cloud Computing', 'Distributed Systems', 'Mobile Development', 'Embedded Systems', 'Open Source Software']
        },
        {
          '@type': 'WebSite',
          '@id': `${siteUrl}/#website`,
          url: siteUrl,
          name: 'MrDevRobot',
          description: t('seo.homeDescription'),
          author: { '@id': `${siteUrl}/#person` },
          inLanguage: ['en-US', 'it-IT']
        }
      ]
    })
  }]
})

const facts = computed(() => [
  { value: 'Noventa di Piave', label: t('hero.facts.base') },
  { value: '2010', label: t('hero.facts.since') },
  { value: '5+', label: t('hero.facts.oss') }
])

const skills = ['.NET', 'AI', 'Clean Architecture', 'DDD', 'CQRS', 'Cloud', 'Distributed Systems', 'Mobile & Embedded', 'Open Source']

const projects = [
  {
    name: 'BLite',
    url: 'https://github.com/EntglDb/BLite',
    desc: 'Zero-allocation embedded document DB for .NET. LINQ, HNSW vector search, R-Tree geospatial, CDC, time series.',
    meta: 'database · storage engine'
  },
  {
    name: 'EntglDb',
    url: 'https://github.com/EntglDb/EntglDb.Net',
    desc: 'P2P data sync middleware. Mesh replication, hash-chained oplog, vector clocks, conflict resolution.',
    meta: 'sync · distributed'
  },
  {
    name: 'Concordia.Core',
    url: 'https://github.com/mrdevrobot/Concordia',
    desc: 'Lightweight .NET mediator. Compile-time handler registration via Source Generators. Free MediatR alternative.',
    meta: 'mediator · source generators'
  },
  {
    name: 'ProjectR',
    url: 'https://github.com/mrdevrobot/ProjectR',
    desc: 'Object-to-object mapping with zero runtime reflection. Source-generated, AOT-compatible.',
    meta: 'mapping · AOT'
  },
  {
    name: 'TransactR',
    url: 'https://github.com/mrdevrobot/TransactR',
    desc: 'Multi-step operations using Memento & Saga patterns, pluggable persistence and rollback policies.',
    meta: 'saga · memento'
  }
]
</script>

<style scoped>
/* ── Hero ── */
.hero {
  padding: clamp(4rem, 10vw, 7.5rem) 0 clamp(3rem, 6vw, 4.5rem);
}

.hero__inner {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1.5rem;
}

.hero__title {
  display: flex;
  flex-direction: column;
  gap: 0.15em;
  font-size: clamp(2.6rem, 2rem + 4.5vw, 5.4rem);
  font-weight: 760;
  letter-spacing: -0.04em;
  line-height: 1.02;
}

.hero__headline {
  padding-bottom: 0.08em;
}

.hero__lead {
  max-width: 36rem;
  font-size: clamp(1.05rem, 1rem + 0.4vw, 1.25rem);
  line-height: 1.6;
  color: var(--text-2);
}

.hero__actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
}

.btn__arrow,
.btn__gh {
  width: 16px;
  height: 16px;
}

.btn__arrow {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.btn__gh {
  fill: currentColor;
}

.hero__facts {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0 2.5rem;
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  width: 100%;
}

.hero__facts li {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.5rem 0;
}

.hero__fact-value {
  font-weight: 640;
  letter-spacing: -0.02em;
  font-size: 1.05rem;
}

.hero__fact-label {
  font-size: 0.78rem;
  color: var(--text-3);
}

/* ── Bento ── */
.about {
  padding: 1rem 0 3rem;
}

.bento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 1rem;
}

.bento__about {
  grid-column: span 12;
  padding: 1.75rem;
}

.bento__avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--bg);
  outline: 1px solid var(--border-strong);
  box-shadow: 0 0 0 6px var(--accent-soft);
  margin-bottom: 1.25rem;
}

.bento__title {
  margin-bottom: 0.9rem;
}

.bento__text {
  color: var(--text-2);
  line-height: 1.7;
  max-width: 60ch;
}

.bento__text + .bento__text {
  margin-top: 0.75rem;
}

.bento__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 1.4rem;
}

.bento__tile {
  grid-column: span 12;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 1.5rem;
  text-decoration: none;
  min-height: 190px;
}

.bento__tile-kicker {
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}

.bento__tile-title {
  font-size: 1.3rem;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.bento__tile-text {
  font-size: 0.92rem;
  color: var(--text-2);
  line-height: 1.6;
}

.bento__tile-arrow {
  margin-top: auto;
  align-self: flex-end;
  font-size: 1.2rem;
  color: var(--text-3);
  transition: color var(--t-fast), transform var(--t-fast);
}

.bento__tile:hover .bento__tile-arrow {
  color: var(--accent);
  transform: translate(2px, -2px);
}

@media (min-width: 760px) {
  .bento__about { grid-column: span 7; grid-row: span 2; }
  .bento__tile { grid-column: span 5; }
}

/* ── Projects ── */
.projects {
  padding: 2rem 0 3rem;
}

.projects__grid {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.project {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  height: 100%;
  padding: 1.4rem;
  text-decoration: none;
}

.project__icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 1rem;
  color: var(--accent-ink);
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 8px 20px -10px var(--glow-1);
  margin-bottom: 0.6rem;
}

.project__name {
  font-weight: 650;
  font-size: 1.05rem;
  letter-spacing: -0.015em;
}

.project__desc {
  font-size: 0.9rem;
  color: var(--text-2);
  line-height: 1.6;
}

.project__meta {
  margin-top: auto;
  padding-top: 0.9rem;
  font-size: 0.7rem;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

/* ── Articles ── */
.latest {
  padding: 2rem 0 5rem;
}

.articles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.no-articles {
  color: var(--text-3);
}
</style>

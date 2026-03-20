<template>
  <div>
    <!-- Hero -->
    <section class="hero">
      <div class="scanlines" aria-hidden="true" />
      <div class="container hero__inner">
        <p class="hero__eyebrow">// luca.fabbri.init(1984)</p>
        <h1 class="hero__title">Luca Fabbri<span class="hero__cursor" aria-hidden="true">_</span></h1>
        <p class="hero__subtitle">{{ $t('hero.subtitle') }}</p>
        <div class="hero__actions">
          <NuxtLink :to="localePath('/blog')" class="btn btn--primary">{{ $t('hero.cta') }}</NuxtLink>
          <a href="https://github.com/mrdevrobot" target="_blank" rel="noopener" class="btn btn--ghost">
            ~/github/mrdevrobot
          </a>
        </div>
      </div>
    </section>

    <!-- About -->
    <section class="about">
      <div class="container about__grid">
        <div class="about__bio">
          <h2 class="retro-heading">{{ $t('about.title') }}</h2>
          <p class="about__text">{{ $t('about.intro') }}</p>
          <p class="about__text">{{ $t('about.expertise') }}</p>
          <p class="about__text">{{ $t('about.blog_description') }}</p>
          <a href="https://xedotnet.org" target="_blank" rel="noopener" class="xedotnet-link">
            <span class="prompt">&gt;&nbsp;</span>XeDotNet
          </a>
          <p class="xedotnet-desc">{{ $t('about.xedotnet') }}</p>
          <div class="tag-cloud">
            <span class="retro-tag">.NET</span>
            <span class="retro-tag">Clean Architecture</span>
            <span class="retro-tag">DDD</span>
            <span class="retro-tag">CQRS</span>
            <span class="retro-tag">Cloud</span>
            <span class="retro-tag">Distributed Systems</span>
            <span class="retro-tag">Mobile &amp; Embedded</span>
            <span class="retro-tag">Open Source</span>
          </div>
        </div>
        <div>
          <h3 class="retro-heading retro-heading--sm">{{ $t('about.opensource') }}</h3>
          <ul class="projects-list">
            <li v-for="proj in projects" :key="proj.name">
              <a :href="proj.url" target="_blank" rel="noopener" class="project-card">
                <div class="project-card__hd">
                  <span class="project-card__caret">&gt;</span>
                  <span class="project-card__name">{{ proj.name }}</span>
                </div>
                <p class="project-card__desc">{{ proj.desc }}</p>
              </a>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Latest Articles -->
    <section class="latest">
      <div class="container">
        <h2 class="retro-heading">{{ $t('article.latestArticles') }}</h2>
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

    <!-- Fun / Dungeon -->
    <section class="fun-section">
      <div class="container">
        <h2 class="retro-heading">{{ $t('fun.title') }}</h2>
        <p class="fun-desc">{{ $t('fun.desc') }}</p>
        <ClientOnly>
          <DungeonGame />
        </ClientOnly>
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
  () => queryContent(`/${locale.value}/blog`).sort({ date: -1 }).limit(3).find()
)

useSeoMeta({
  title: 'Luca Fabbri',
  description: () => t('seo.homeDescription'),
  ogTitle: 'Luca Fabbri · MrDevRobot',
  ogDescription: () => t('seo.homeDescription'),
  ogImage: `${siteUrl}/luca-fabbri.jpg`,
  ogImageAlt: 'Luca Fabbri — Tech Lead & .NET Engineer',
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
          jobTitle: 'Tech Lead',
          worksFor: { '@type': 'Organization', name: 'Zucchetti Hospitality Srl' },
          birthPlace: { '@type': 'Place', name: 'Rimini, Italy' },
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'San Donà di Piave',
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

const projects = [
  {
    name: 'BLite',
    url: 'https://github.com/EntglDb/BLite',
    desc: 'Zero-allocation embedded document DB for .NET. LINQ, HNSW vector search, R-Tree geospatial, CDC, time series.'
  },
  {
    name: 'EntglDb',
    url: 'https://github.com/EntglDb/EntglDb.Net',
    desc: 'P2P data sync middleware. Mesh replication, hash-chained oplog, vector clocks, conflict resolution.'
  },
  {
    name: 'Concordia.Core',
    url: 'https://github.com/mrdevrobot/Concordia',
    desc: 'Lightweight .NET mediator. Compile-time handler registration via Source Generators. Free MediatR alternative.'
  },
  {
    name: 'ProjectR',
    url: 'https://github.com/mrdevrobot/ProjectR',
    desc: 'Object-to-object mapping with zero runtime reflection. Source-generated, AOT-compatible.'
  },
  {
    name: 'TransactR',
    url: 'https://github.com/mrdevrobot/TransactR',
    desc: 'Multi-step operations using Memento & Saga patterns, pluggable persistence and rollback policies.'
  },
]
</script>

<style scoped>
/* ── Hero ── */
.hero {
  position: relative;
  background: #0c0e0c;
  padding: 5.5rem 0 4.5rem;
  overflow: hidden;
}

.scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 3px,
    rgba(0, 0, 0, 0.07) 3px,
    rgba(0, 0, 0, 0.07) 4px
  );
  pointer-events: none;
  z-index: 0;
}

.hero__inner {
  position: relative;
  z-index: 1;
}

.hero__eyebrow {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #22c55e;
  opacity: 0.5;
  letter-spacing: 0.06em;
  margin-bottom: 1.1rem;
}

.hero__title {
  font-family: 'Space Mono', monospace;
  font-size: clamp(2.2rem, 5vw, 3.5rem);
  font-weight: 700;
  color: #4ade80;
  line-height: 1.1;
  letter-spacing: -0.02em;
  margin-bottom: 1.1rem;
  text-shadow: 0 0 28px rgba(74, 222, 128, 0.3);
}

.hero__cursor {
  display: inline-block;
  color: #4ade80;
  animation: blink 1s step-end infinite;
  margin-left: 3px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.hero__subtitle {
  font-family: 'Space Mono', monospace;
  font-size: 0.8rem;
  color: #4ade80;
  opacity: 0.5;
  max-width: 560px;
  margin-bottom: 2.5rem;
  letter-spacing: 0.02em;
  line-height: 1.65;
}

.hero__actions {
  display: flex;
  gap: 0.875rem;
  flex-wrap: wrap;
}

.btn {
  font-family: 'Space Mono', monospace;
  font-size: 0.73rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.6rem 1.35rem;
  text-decoration: none;
  border: 1px solid;
  display: inline-block;
  transition: all 0.15s ease;
}

.btn--primary {
  background: #4ade80;
  color: #0c0e0c;
  border-color: #4ade80;
}

.btn--primary:hover {
  background: #86efac;
  border-color: #86efac;
  box-shadow: 0 0 18px rgba(74, 222, 128, 0.35);
}

.btn--ghost {
  background: transparent;
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.35);
  opacity: 0.65;
}

.btn--ghost:hover {
  opacity: 1;
  border-color: rgba(74, 222, 128, 0.6);
  background: rgba(74, 222, 128, 0.06);
}

/* ── About ── */
.about {
  background: #f5f3e8;
  padding: 4rem 1.25rem;
  border-bottom: 1px solid #e7e2d4;
}

.about__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3.5rem;
  padding: 0;
}

@media (max-width: 720px) {
  .about__grid { grid-template-columns: 1fr; gap: 2.5rem; }
}

.retro-heading {
  font-family: 'Space Mono', monospace;
  font-size: 1.3rem;
  font-weight: 700;
  color: #0c0e0c;
  margin-bottom: 1.5rem;
}

.retro-heading::before {
  content: '// ';
  color: #22c55e;
  font-weight: 400;
}

.retro-heading--sm {
  font-size: 0.92rem;
  margin-bottom: 1rem;
}

.about__text {
  font-size: 0.92rem;
  color: #44403c;
  margin-bottom: 0.9rem;
  line-height: 1.8;
}

.xedotnet-link {
  display: inline-flex;
  align-items: center;
  font-family: 'Space Mono', monospace;
  font-size: 0.82rem;
  font-weight: 700;
  color: #16a34a;
  text-decoration: none;
  margin-top: 0.5rem;
  transition: text-shadow 0.15s;
}

.xedotnet-link:hover {
  text-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
}

.prompt {
  color: #22c55e;
  opacity: 0.65;
}

.xedotnet-desc {
  font-size: 0.82rem;
  color: #78716c;
  margin: 0.2rem 0 1.25rem;
}

.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 1rem;
}

.retro-tag {
  font-family: 'Space Mono', monospace;
  font-size: 0.67rem;
  color: #16a34a;
  border: 1px solid #86efac;
  background: transparent;
  padding: 0.18rem 0.55rem;
  letter-spacing: 0.02em;
}

/* ── Projects ── */
.projects-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.project-card {
  display: block;
  background: #fff;
  border: 1px solid #e7e2d4;
  border-left: 3px solid #4ade80;
  padding: 0.8rem 1rem;
  text-decoration: none;
  color: inherit;
  transition: border-left-color 0.15s ease, box-shadow 0.15s ease;
}

.project-card:hover {
  border-left-color: #16a34a;
  box-shadow: 3px 0 14px rgba(34, 197, 94, 0.1);
}

.project-card__hd {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.25rem;
}

.project-card__caret {
  font-family: 'Space Mono', monospace;
  font-size: 0.75rem;
  color: #22c55e;
  opacity: 0.5;
}

.project-card__name {
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  font-size: 0.83rem;
  color: #0c0e0c;
}

.project-card__desc {
  font-size: 0.77rem;
  color: #78716c;
  line-height: 1.5;
}

/* ── Latest ── */
.latest {
  background: #f5f3e8;
  padding: 3.5rem 1.25rem 4.5rem;
}

.articles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.1rem;
}

.no-articles {
  font-family: 'Space Mono', monospace;
  font-size: 0.82rem;
  color: #78716c;
}

/* ── Fun / Dungeon ── */
.fun-section {
  background: #f0ede0;
  padding: 3.5rem 1.25rem 4.5rem;
  border-top: 1px solid #e7e2d4;
}

.fun-desc {
  font-size: 0.88rem;
  color: #57534e;
  margin-bottom: 1.75rem;
  line-height: 1.75;
  max-width: 580px;
}
</style>

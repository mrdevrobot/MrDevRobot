<template>
  <section class="article-page">
    <div class="container article-page__inner">
      <NuxtLink :to="localePath('/blog')" class="back-link">
        &gt; {{ $t('article.backToBlog') }}
      </NuxtLink>

      <article v-if="article">
        <header class="article-header">
          <h1 class="article-title">{{ article.title }}</h1>
          <div class="article-meta">
            <time v-if="article.date" class="article-date">
              {{ formatDate(article.date) }}
            </time>
            <div v-if="article.tags && article.tags.length" class="article-tags">
              <span v-for="tag in article.tags" :key="tag" class="retro-tag">
                {{ tag }}
              </span>
            </div>
          </div>
          <p v-if="article.description" class="article-description">
            {{ article.description }}
          </p>
        </header>

        <div class="article-body">
          <ContentRenderer :value="article" />
        </div>
      </article>

      <div v-else class="not-found">
        <p>{{ $t('article.noArticles') }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const route = useRoute()
const { locale, t } = useI18n()
const localePath = useLocalePath()
const siteUrl = 'https://mrdevrobot.com'

const slug = route.params.slug as string

const { data: article } = await useAsyncData(
  `article-${locale.value}-${slug}`,
  () => queryContent(`/${locale.value}/blog/${slug}`).findOne()
)

const articleUrl = computed(() =>
  locale.value === 'en'
    ? `${siteUrl}/blog/${slug}`
    : `${siteUrl}/${locale.value}/blog/${slug}`
)

useSeoMeta({
  title: () => article.value?.title ?? t('article.allArticles'),
  description: () => article.value?.description ?? t('seo.blogDescription'),
  ogTitle: () => `${article.value?.title ?? ''} · MrDevRobot`,
  ogDescription: () => article.value?.description ?? t('seo.blogDescription'),
  ogImage: `${siteUrl}/luca-fabbri.jpg`,
  ogImageAlt: () => article.value?.title ?? 'MrDevRobot',
  ogType: 'article',
  ogUrl: () => articleUrl.value,
  articlePublishedTime: () => article.value?.date,
  articleTag: () => article.value?.tags,
  articleAuthor: [`${siteUrl}/#person`],
  twitterTitle: () => `${article.value?.title ?? ''} · MrDevRobot`,
  twitterDescription: () => article.value?.description ?? t('seo.blogDescription'),
  twitterImage: `${siteUrl}/luca-fabbri.jpg`,
  robots: 'index, follow'
})

useHead({
  script: [{
    type: 'application/ld+json',
    innerHTML: () => article.value ? JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: article.value.title,
      description: article.value.description,
      datePublished: article.value.date,
      author: {
        '@type': 'Person',
        '@id': `${siteUrl}/#person`,
        name: 'Luca Fabbri',
        url: siteUrl
      },
      publisher: {
        '@type': 'Person',
        name: 'Luca Fabbri',
        url: siteUrl
      },
      image: `${siteUrl}/luca-fabbri.jpg`,
      mainEntityOfPage: articleUrl.value,
      keywords: article.value.tags?.join(', ')
    }) : ''
  }]
})

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}
</script>

<style scoped>
.article-page {
  background: #f5f3e8;
  padding: 3rem 1.25rem 5rem;
  min-height: 70vh;
}

.article-page__inner {
  max-width: 720px;
}

.back-link {
  display: inline-block;
  font-family: 'Space Mono', monospace;
  color: #22c55e;
  font-size: 0.75rem;
  text-decoration: none;
  margin-bottom: 2.5rem;
  letter-spacing: 0.04em;
  transition: color 0.15s ease;
}

.back-link:hover {
  color: #4ade80;
}

.article-header {
  margin-bottom: 2.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e7e2d4;
}

.article-title {
  font-family: 'Space Mono', monospace;
  font-size: clamp(1.4rem, 3vw, 2rem);
  font-weight: 700;
  line-height: 1.25;
  color: #0c0e0c;
  margin-bottom: 1rem;
}

.article-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.article-date {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #78716c;
  letter-spacing: 0.04em;
}

.article-tags {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.retro-tag {
  font-family: 'Space Mono', monospace;
  font-size: 0.67rem;
  color: #16a34a;
  border: 1px solid #86efac;
  padding: 0.1rem 0.45rem;
  letter-spacing: 0.03em;
}

.article-description {
  color: #57534e;
  font-size: 1rem;
  line-height: 1.65;
  margin-top: 0.75rem;
  font-style: italic;
}

/* ── Article body markdown ── */
.article-body :deep(h2),
.article-body :deep(h3),
.article-body :deep(h4) {
  font-family: 'Space Mono', monospace;
  margin-top: 2.25rem;
  margin-bottom: 0.75rem;
  font-weight: 700;
  line-height: 1.3;
  color: #0c0e0c;
}

.article-body :deep(h2)::before {
  content: '## ';
  color: #4ade80;
}

.article-body :deep(h3)::before {
  content: '### ';
  color: #4ade80;
}

.article-body :deep(h2) { font-size: 1.25rem; }
.article-body :deep(h3) { font-size: 1.05rem; }

.article-body :deep(p) {
  margin-bottom: 1.25rem;
  color: #3a3631;
  line-height: 1.8;
}

.article-body :deep(ul),
.article-body :deep(ol) {
  margin: 0 0 1.25rem 1.5rem;
  color: #3a3631;
  line-height: 1.8;
}

.article-body :deep(li) {
  margin-bottom: 0.3rem;
}

.article-body :deep(a) {
  color: #16a34a;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.article-body :deep(code) {
  background: #e8f5e9;
  color: #166534;
  border: 1px solid #bbf7d0;
  padding: 0.15em 0.35em;
  font-size: 0.88em;
  font-family: 'Space Mono', monospace;
}

.article-body :deep(pre) {
  background: #0c0e0c;
  color: #4ade80;
  border-left: 3px solid #4ade80;
  padding: 1.25rem;
  overflow-x: auto;
  margin-bottom: 1.5rem;
  font-size: 0.88rem;
  line-height: 1.6;
}

.article-body :deep(pre code) {
  background: transparent;
  color: inherit;
  border: none;
  padding: 0;
  font-size: inherit;
}

.article-body :deep(blockquote) {
  border-left: 3px solid #4ade80;
  background: rgba(74, 222, 128, 0.05);
  padding: 0.75rem 1rem;
  color: #57534e;
  font-style: italic;
  margin: 1.5rem 0;
}

.article-body :deep(hr) {
  border: none;
  border-top: 1px solid #e7e2d4;
  margin: 2rem 0;
}

/* ── Tables ── */
.article-body :deep(table) {
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1.5rem;
  font-size: 0.82rem;
  font-family: 'Space Mono', monospace;
  white-space: nowrap;
}

.article-body :deep(thead th) {
  background: #0c0e0c;
  color: #4ade80;
  padding: 0.5rem 0.9rem;
  text-align: left;
  font-weight: 700;
  border: 1px solid #374137;
  letter-spacing: 0.03em;
}

.article-body :deep(tbody td) {
  padding: 0.45rem 0.9rem;
  border: 1px solid #dcd8cc;
  color: #3a3631;
  vertical-align: middle;
}

.article-body :deep(tbody tr:nth-child(even) td) {
  background: #eeece0;
}

.article-body :deep(tbody tr:hover td) {
  background: #e6f4ea;
}

.not-found {
  font-family: 'Space Mono', monospace;
  color: #78716c;
  font-size: 0.9rem;
}
</style>

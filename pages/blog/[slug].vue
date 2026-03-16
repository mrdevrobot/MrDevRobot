<template>
  <div class="container article-page">
    <NuxtLink :to="localePath('/blog')" class="back-link">
      {{ $t('article.backToBlog') }}
    </NuxtLink>

    <article v-if="article">
      <header class="article-header">
        <h1 class="article-title">{{ article.title }}</h1>
        <div class="article-meta">
          <time v-if="article.date" class="article-date">
            {{ formatDate(article.date) }}
          </time>
          <div v-if="article.tags && article.tags.length" class="article-tags">
            <span v-for="tag in article.tags" :key="tag" class="article-tag">
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
</template>

<script setup lang="ts">
const route = useRoute()
const { locale } = useI18n()
const localePath = useLocalePath()

const slug = route.params.slug as string

const { data: article } = await useAsyncData(
  `article-${locale.value}-${slug}`,
  () => queryContent(`/${locale.value}/blog/${slug}`).findOne()
)

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
  max-width: 720px;
}

.back-link {
  display: inline-block;
  color: #16a34a;
  font-weight: 600;
  font-size: 0.9rem;
  text-decoration: none;
  margin-bottom: 2rem;
  transition: color 0.15s ease;
}

.back-link:hover {
  color: #15803d;
}

.article-header {
  margin-bottom: 2.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.article-title {
  font-size: 2.25rem;
  font-weight: 800;
  line-height: 1.2;
  color: #111827;
  margin-bottom: 1rem;
  letter-spacing: -0.02em;
}

.article-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.article-date {
  font-size: 0.875rem;
  color: #6b7280;
}

.article-tags {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.article-tag {
  font-size: 0.75rem;
  background: #f0fdf4;
  color: #16a34a;
  border: 1px solid #bbf7d0;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.article-description {
  color: #4b5563;
  font-size: 1.05rem;
  line-height: 1.6;
  margin-top: 0.75rem;
}

/* Markdown content styles */
.article-body :deep(h1),
.article-body :deep(h2),
.article-body :deep(h3),
.article-body :deep(h4) {
  margin-top: 2rem;
  margin-bottom: 0.75rem;
  font-weight: 700;
  line-height: 1.3;
  color: #111827;
}

.article-body :deep(h1) { font-size: 1.875rem; }
.article-body :deep(h2) { font-size: 1.5rem; }
.article-body :deep(h3) { font-size: 1.25rem; }

.article-body :deep(p) {
  margin-bottom: 1.25rem;
  color: #374151;
  line-height: 1.75;
}

.article-body :deep(ul),
.article-body :deep(ol) {
  margin: 0 0 1.25rem 1.5rem;
  color: #374151;
  line-height: 1.75;
}

.article-body :deep(li) {
  margin-bottom: 0.25rem;
}

.article-body :deep(a) {
  color: #16a34a;
  text-decoration: underline;
}

.article-body :deep(code) {
  background: #f3f4f6;
  padding: 0.15em 0.35em;
  border-radius: 0.25rem;
  font-size: 0.9em;
  font-family: 'Fira Code', 'Courier New', monospace;
}

.article-body :deep(pre) {
  background: #1f2937;
  color: #f9fafb;
  padding: 1.25rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  margin-bottom: 1.5rem;
}

.article-body :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}

.article-body :deep(blockquote) {
  border-left: 4px solid #16a34a;
  padding-left: 1rem;
  color: #4b5563;
  font-style: italic;
  margin: 1.5rem 0;
}

.not-found {
  color: #6b7280;
}
</style>

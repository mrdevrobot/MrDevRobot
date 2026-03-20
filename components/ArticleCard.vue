<template>
  <article class="article-card">
    <div class="article-card__content">
      <div class="article-card__meta">
        <time v-if="article.date" class="article-card__date">
          {{ formatDate(article.date) }}
        </time>
        <div v-if="article.tags && article.tags.length" class="article-card__tags">
          <span v-for="tag in article.tags" :key="tag" class="article-card__tag">
            {{ tag }}
          </span>
        </div>
      </div>
      <h2 class="article-card__title">
        <NuxtLink :to="localePath(`/blog/${article._path?.split('/').pop()}`)">
          {{ article.title }}
        </NuxtLink>
      </h2>
      <p v-if="article.description" class="article-card__description">
        {{ article.description }}
      </p>
      <NuxtLink
        :to="localePath(`/blog/${article._path?.split('/').pop()}`)"
        class="article-card__read-more"
      >
        &gt; {{ $t('article.readMore') }}
      </NuxtLink>
    </div>
  </article>
</template>

<script setup lang="ts">
const localePath = useLocalePath()

interface Article {
  title: string
  description?: string
  date?: string
  tags?: string[]
  _path?: string
}

defineProps<{
  article: Article
}>()

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}
</script>

<style scoped>
.article-card {
  background: #fff;
  border: 1px solid #e7e2d4;
  border-left: 3px solid #4ade80;
  overflow: hidden;
  transition: border-color 0.15s ease;
}

.article-card:hover {
  border-left-color: #22c55e;
}

.article-card__content {
  padding: 1.25rem 1.25rem 1.25rem 1.1rem;
}

.article-card__meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}

.article-card__date {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #78716c;
  letter-spacing: 0.04em;
}

.article-card__tags {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.article-card__tag {
  font-family: 'Space Mono', monospace;
  font-size: 0.67rem;
  color: #16a34a;
  border: 1px solid #86efac;
  padding: 0.1rem 0.45rem;
  letter-spacing: 0.03em;
}

.article-card__title {
  font-size: 1rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  line-height: 1.45;
  font-family: 'Space Mono', monospace;
}

.article-card__title a {
  color: #0c0e0c;
  text-decoration: none;
  transition: color 0.15s ease;
}

.article-card__title a:hover {
  color: #16a34a;
}

.article-card__description {
  color: #57534e;
  font-size: 0.92rem;
  line-height: 1.65;
  margin: 0 0 1rem;
}

.article-card__read-more {
  display: inline-block;
  font-family: 'Space Mono', monospace;
  color: #16a34a;
  font-size: 0.75rem;
  text-decoration: none;
  letter-spacing: 0.04em;
  transition: color 0.15s ease;
}

.article-card__read-more:hover {
  color: #4ade80;
}
</style>

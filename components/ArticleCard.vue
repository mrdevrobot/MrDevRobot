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
        {{ $t('article.readMore') }} →
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
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  overflow: hidden;
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}

.article-card:hover {
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

.article-card__content {
  padding: 1.5rem;
}

.article-card__meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.article-card__date {
  font-size: 0.875rem;
  color: #6b7280;
}

.article-card__tags {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.article-card__tag {
  font-size: 0.75rem;
  background: #f0fdf4;
  color: #16a34a;
  border: 1px solid #bbf7d0;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.article-card__title {
  font-size: 1.25rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  line-height: 1.4;
}

.article-card__title a {
  color: #111827;
  text-decoration: none;
  transition: color 0.15s ease;
}

.article-card__title a:hover {
  color: #16a34a;
}

.article-card__description {
  color: #4b5563;
  font-size: 0.95rem;
  line-height: 1.6;
  margin: 0 0 1rem;
}

.article-card__read-more {
  display: inline-block;
  color: #16a34a;
  font-weight: 600;
  font-size: 0.875rem;
  text-decoration: none;
  transition: color 0.15s ease;
}

.article-card__read-more:hover {
  color: #15803d;
}
</style>

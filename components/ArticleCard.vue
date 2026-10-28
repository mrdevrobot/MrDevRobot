<template>
  <article class="article-card card card--hover card--glow reveal">
    <NuxtLink :to="link" class="article-card__link">
      <div class="article-card__meta">
        <time v-if="article.date" class="article-card__date mono" :datetime="article.date">
          {{ formatDate(article.date) }}
        </time>
      </div>
      <h2 class="article-card__title">{{ article.title }}</h2>
      <p v-if="article.description" class="article-card__description">
        {{ article.description }}
      </p>
      <div class="article-card__foot">
        <div v-if="article.tags && article.tags.length" class="article-card__tags">
          <span v-for="tag in article.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
        </div>
        <span class="article-card__arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </span>
      </div>
    </NuxtLink>
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

const props = defineProps<{
  article: Article
}>()

const link = computed(() => localePath(`/blog/${props.article._path?.split('/').pop()}`))

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
</script>

<style scoped>
.article-card {
  display: flex;
}

.article-card__link {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 1.4rem 1.4rem 1.2rem;
  text-decoration: none;
  border-radius: inherit;
}

.article-card__meta {
  margin-bottom: 0.8rem;
}

.article-card__date {
  font-size: 0.72rem;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

.article-card__title {
  font-size: 1.08rem;
  font-weight: 640;
  letter-spacing: -0.015em;
  line-height: 1.35;
  color: var(--text);
  margin-bottom: 0.55rem;
  transition: color var(--t-fast);
}

.article-card:hover .article-card__title {
  color: var(--accent);
}

.article-card__description {
  color: var(--text-2);
  font-size: 0.92rem;
  line-height: 1.6;
  margin-bottom: 1.25rem;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.article-card__foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.article-card__tags {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.article-card__arrow {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  color: var(--text-2);
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}

.article-card__arrow svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.article-card:hover .article-card__arrow {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}
</style>

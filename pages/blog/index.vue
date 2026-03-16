<template>
  <div class="container">
    <h1 class="page-title">{{ $t('article.allArticles') }}</h1>
    <div v-if="articles && articles.length" class="articles-grid">
      <ArticleCard
        v-for="article in articles"
        :key="article._path"
        :article="article"
      />
    </div>
    <p v-else class="no-articles">{{ $t('article.noArticles') }}</p>
  </div>
</template>

<script setup lang="ts">
const { locale } = useI18n()

const { data: articles } = await useAsyncData(
  `blog-articles-${locale.value}`,
  () => queryContent(`/${locale.value}/blog`).sort({ date: -1 }).find()
)
</script>

<style scoped>
.page-title {
  font-size: 2rem;
  font-weight: 800;
  margin-bottom: 2rem;
  color: #111827;
}

.articles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.5rem;
}

.no-articles {
  color: #6b7280;
  font-size: 1rem;
}
</style>

<template>
  <section class="blog-listing">
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
  </section>
</template>

<script setup lang="ts">
const { locale, t } = useI18n()
const siteUrl = 'https://mrdevrobot.com'

const today = new Date().toISOString().split('T')[0]

const { data: articles } = await useAsyncData(
  `blog-articles-${locale.value}`,
  () => queryContent(`/${locale.value}/blog`)
    .where({ date: { $lte: today } })
    .sort({ date: -1 })
    .find()
)

useSeoMeta({
  title: () => t('seo.blogTitle'),
  description: () => t('seo.blogDescription'),
  ogTitle: () => `${t('seo.blogTitle')} · MrDevRobot`,
  ogDescription: () => t('seo.blogDescription'),
  ogImage: `${siteUrl}/luca-fabbri.jpg`,
  ogImageAlt: 'MrDevRobot Blog',
  ogType: 'website',
  ogUrl: () => locale.value === 'en' ? `${siteUrl}/blog` : `${siteUrl}/${locale.value}/blog`,
  twitterTitle: () => `${t('seo.blogTitle')} · MrDevRobot`,
  twitterDescription: () => t('seo.blogDescription'),
  twitterImage: `${siteUrl}/luca-fabbri.jpg`,
  robots: 'index, follow'
})
</script>

<style scoped>
.blog-listing {
  background: #f5f3e8;
  padding: 3rem 1.25rem 4rem;
  min-height: 60vh;
}

.page-title {
  font-family: 'Space Mono', monospace;
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 2rem;
  color: #0c0e0c;
  letter-spacing: -0.01em;
}

.page-title::before {
  content: '// ';
  color: #4ade80;
}

.articles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}

.no-articles {
  font-family: 'Space Mono', monospace;
  color: #78716c;
  font-size: 0.9rem;
}
</style>

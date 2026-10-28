<template>
  <section class="blog-listing">
    <div class="container">
      <header class="blog-listing__head">
        <p class="eyebrow">{{ $t('nav.blog') }}</p>
        <h1 class="blog-listing__title">{{ $t('article.allArticles') }}</h1>
        <p class="blog-listing__lead">{{ $t('seo.blogDescription') }}</p>
      </header>
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
  padding: clamp(3rem, 7vw, 5rem) 0 5rem;
  min-height: 60vh;
}

.blog-listing__head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 2.5rem;
}

.blog-listing__title {
  font-size: clamp(2rem, 1.5rem + 2.5vw, 3.2rem);
  font-weight: 740;
  letter-spacing: -0.035em;
  line-height: 1.05;
}

.blog-listing__lead {
  max-width: 40rem;
  color: var(--text-2);
  font-size: 1.02rem;
  line-height: 1.6;
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

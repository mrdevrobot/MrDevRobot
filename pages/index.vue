<template>
  <div>
    <!-- Hero Section -->
    <section class="hero">
      <div class="container">
        <h1 class="hero__title">{{ $t('hero.title') }}</h1>
        <p class="hero__subtitle">{{ $t('hero.subtitle') }}</p>
        <NuxtLink :to="localePath('/blog')" class="hero__cta">
          {{ $t('hero.cta') }}
        </NuxtLink>
      </div>
    </section>

    <!-- Latest Articles -->
    <section class="latest-articles container">
      <h2 class="section-title">{{ $t('article.latestArticles') }}</h2>
      <div v-if="articles && articles.length" class="articles-grid">
        <ArticleCard
          v-for="article in articles"
          :key="article._path"
          :article="article"
        />
      </div>
      <p v-else class="no-articles">{{ $t('article.noArticles') }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
const { locale } = useI18n()
const localePath = useLocalePath()

const { data: articles } = await useAsyncData(
  `home-articles-${locale.value}`,
  () => queryContent(`/${locale.value}/blog`).sort({ date: -1 }).limit(3).find()
)
</script>

<style scoped>
/* ── Hero ── */
.hero {
  background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
  color: #fff;
  padding: 5rem 0 4rem;
  text-align: center;
}

.hero__title {
  font-size: 2.75rem;
  font-weight: 800;
  line-height: 1.15;
  margin-bottom: 1rem;
  letter-spacing: -0.02em;
}

.hero__subtitle {
  font-size: 1.15rem;
  opacity: 0.9;
  max-width: 560px;
  margin: 0 auto 2rem;
}

.hero__cta {
  display: inline-block;
  background: #fff;
  color: #16a34a;
  font-weight: 700;
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.hero__cta:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
}

/* ── Latest Articles ── */
.latest-articles {
  padding: 2.5rem 1.25rem;
}

.section-title {
  font-size: 1.75rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
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

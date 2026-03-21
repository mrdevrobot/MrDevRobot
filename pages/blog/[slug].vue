<template>
  <section class="article-page" :class="{ 'article-page--focus': focusMode }">
    <!-- Focus mode overlay -->
    <Teleport to="body">
      <div v-if="focusMode" class="focus-overlay" @click="focusMode = false" />
    </Teleport>

    <div class="container article-page__layout">
      <!-- ── Main column ── -->
      <div class="article-page__main">
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
              <span v-if="readingTime" class="article-readtime">
                ~{{ readingTime }} min read
              </span>
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

          <div ref="articleBodyRef" class="article-body">
            <ContentRenderer :value="article" />
          </div>
        </article>

        <div v-else class="not-found">
          <p>{{ $t('article.noArticles') }}</p>
        </div>
      </div>

      <!-- ── Sidebar ── -->
      <aside v-if="article" class="article-sidebar" :class="{ 'article-sidebar--focus': focusMode }">
        <!-- Action buttons -->
        <div class="sidebar-actions">
          <button class="sidebar-btn sidebar-btn--focus" :class="{ active: focusMode }" :title="$t('article.focusMode')" @click="focusMode = !focusMode">
            <span class="btn-icon">{{ focusMode ? '⊠' : '⊡' }}</span>
            <span class="btn-label">{{ focusMode ? $t('article.exitFocus') : $t('article.focusMode') }}</span>
          </button>
          <button class="sidebar-btn" :title="$t('article.exportPdf')" @click="exportPdf">
            <span class="btn-icon">⎙</span>
            <span class="btn-label">{{ $t('article.exportPdf') }}</span>
          </button>
          <button class="sidebar-btn" :title="$t('article.exportMd')" @click="exportMarkdown">
            <span class="btn-icon">↓</span>
            <span class="btn-label">{{ $t('article.exportMd') }}</span>
          </button>
        </div>

        <!-- Table of contents -->
        <nav v-if="toc.length" class="sidebar-toc">
          <p class="sidebar-toc__title">> {{ $t('article.toc') }}</p>
          <ul class="sidebar-toc__list">
            <li
              v-for="item in toc"
              :key="item.id"
              class="sidebar-toc__item"
              :class="[`toc-depth-${item.depth}`, { active: activeHeading === item.id }]"
            >
              <a :href="`#${item.id}`" class="sidebar-toc__link" @click.prevent="scrollTo(item.id)">
                {{ item.text }}
              </a>
            </li>
          </ul>
        </nav>
      </aside>
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
  () => queryContent(`/${locale.value}/blog/${slug}`)
    .where({ date: { $lte: new Date().toISOString().split('T')[0] } })
    .findOne()
)

if (!article.value) {
  throw createError({ statusCode: 404, fatal: true })
}

const articleUrl = computed(() =>
  locale.value === 'en'
    ? `${siteUrl}/blog/${slug}`
    : `${siteUrl}/${locale.value}/blog/${slug}`
)

// ── Reading time ──────────────────────────────────────────────
const readingTime = computed(() => {
  if (!article.value?.body) return null
  const text = JSON.stringify(article.value.body)
  const words = text.split(/\s+/).length
  return Math.max(1, Math.round(words / 200))
})

// ── TOC ───────────────────────────────────────────────────────
interface TocItem { id: string; text: string; depth: number }

const toc = computed<TocItem[]>(() => {
  const body = article.value?.body
  if (!body) return []
  const items: TocItem[] = []
  function walk(node: any) {
    if (!node) return
    if (['h2', 'h3', 'h4'].includes(node.tag)) {
      const text = node.children?.map((c: any) => c.value ?? '').join('') ?? ''
      const id = node.props?.id ?? text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
      if (text) items.push({ id, text, depth: parseInt(node.tag[1]) })
    }
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  if (Array.isArray(body.children)) body.children.forEach(walk)
  return items
})

// ── Active heading on scroll ──────────────────────────────────
const activeHeading = ref<string>('')
const articleBodyRef = ref<HTMLElement | null>(null)
let scrollObserver: IntersectionObserver | null = null

onMounted(() => {
  if (!toc.value.length) return
  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeHeading.value = entry.target.id
          break
        }
      }
    },
    { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
  )
  toc.value.forEach(item => {
    const el = document.getElementById(item.id)
    if (el) scrollObserver!.observe(el)
  })
})

onUnmounted(() => scrollObserver?.disconnect())

function scrollTo(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── Focus mode ────────────────────────────────────────────────
const focusMode = ref(false)

// ── Export PDF ────────────────────────────────────────────────
function exportPdf() {
  window.print()
}

// ── Export Markdown ───────────────────────────────────────────
function exportMarkdown() {
  if (!article.value) return
  const mdUrl = locale.value === 'en'
    ? `/blog/${slug}`
    : `/${locale.value}/blog/${slug}`
  // Fetch the raw .md source from the content API
  fetch(`/api/_content/query?_params=${encodeURIComponent(JSON.stringify({ where: { _path: `/${locale.value}/blog/${slug}` } }))}`)
    .then(r => r.json())
    .then(data => {
      const raw = data?.[0]?.rawbody ?? buildFallbackMd()
      downloadFile(raw, `${slug}.md`, 'text/markdown')
    })
    .catch(() => downloadFile(buildFallbackMd(), `${slug}.md`, 'text/markdown'))
}

function buildFallbackMd(): string {
  if (!article.value) return ''
  const a = article.value
  const fm = [
    '---',
    `title: "${a.title}"`,
    `date: "${a.date}"`,
    `description: "${a.description}"`,
    `tags: [${a.tags?.map((t: string) => `"${t}"`).join(', ') ?? ''}]`,
    '---',
    '',
    `# ${a.title}`,
    '',
    a.description ?? ''
  ].join('\n')
  return fm
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

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
/* ── Page wrapper ── */
.article-page {
  background: #f5f3e8;
  padding: 3rem 1.25rem 5rem;
  min-height: 70vh;
}

/* ── Two-column layout ── */
.article-page__layout {
  display: grid;
  grid-template-columns: 1fr 240px;
  gap: 3rem;
  max-width: 1020px;
  margin: 0 auto;
  align-items: start;
}

.article-page__main {
  min-width: 0;
}

/* ── Back link ── */
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

/* ── Article header ── */
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

.article-readtime {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #78716c;
  letter-spacing: 0.04em;
}

.article-readtime::before {
  content: '·';
  margin-right: 0.4rem;
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

/* inline code only — block code is handled by ProseCode.vue */
.article-body :deep(code) {
  background: #e8f5e9;
  color: #166534;
  border: 1px solid #bbf7d0;
  padding: 0.15em 0.4em;
  font-size: 0.87em;
  font-family: 'Space Mono', monospace;
  border-radius: 2px;
}

/* reset inline code inside a pre (block code) */
.article-body :deep(pre code) {
  background: transparent !important;
  color: inherit !important;
  border: none !important;
  padding: 0 !important;
  font-size: inherit !important;
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

/* ── Not found ── */
.not-found {
  font-family: 'Space Mono', monospace;
  color: #78716c;
  font-size: 0.9rem;
}

/* ── Sidebar ── */
.article-sidebar {
  position: sticky;
  top: 5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  transition: opacity 0.3s ease;
}

.article-sidebar--focus {
  opacity: 0;
  pointer-events: none;
}

/* ── Sidebar action buttons ── */
.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sidebar-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #3a3631;
  background: transparent;
  border: 1px solid #c8c2b4;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  letter-spacing: 0.03em;
  text-align: left;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  width: 100%;
}

.sidebar-btn:hover {
  border-color: #4ade80;
  color: #16a34a;
  background: rgba(74, 222, 128, 0.06);
}

.sidebar-btn--focus.active {
  border-color: #4ade80;
  color: #16a34a;
  background: rgba(74, 222, 128, 0.08);
}

.btn-icon {
  flex-shrink: 0;
  width: 1em;
  text-align: center;
}

/* ── Table of contents ── */
.sidebar-toc__title {
  font-family: 'Space Mono', monospace;
  font-size: 0.72rem;
  color: #4ade80;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
  text-transform: uppercase;
}

.sidebar-toc__list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-left: 1px solid #e7e2d4;
}

.sidebar-toc__item {
  line-height: 1.4;
}

.sidebar-toc__link {
  display: block;
  font-family: 'Space Mono', monospace;
  font-size: 0.68rem;
  color: #78716c;
  text-decoration: none;
  padding: 0.25rem 0.6rem;
  border-left: 2px solid transparent;
  margin-left: -1px;
  transition: color 0.15s, border-color 0.15s;
  line-height: 1.5;
  word-break: break-word;
  white-space: normal;
}

.sidebar-toc__link:hover {
  color: #3a3631;
  border-left-color: #c8c2b4;
}

.sidebar-toc__item.active .sidebar-toc__link {
  color: #16a34a;
  border-left-color: #4ade80;
}

.toc-depth-3 .sidebar-toc__link { padding-left: 1.25rem; }
.toc-depth-4 .sidebar-toc__link { padding-left: 2rem; }

/* ── Focus mode overlay ── */
.focus-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 10;
  cursor: pointer;
}

.article-page--focus .article-page__main {
  position: relative;
  z-index: 11;
  background: #f5f3e8;
  border-radius: 2px;
  box-shadow: 0 8px 48px rgba(0, 0, 0, 0.25);
  padding: 2rem;
}

/* ── Print ── */
@media print {
  .article-sidebar,
  .focus-overlay,
  .back-link {
    display: none !important;
  }

  .article-page {
    background: #fff !important;
    padding: 0 !important;
  }

  .article-page__layout {
    display: block !important;
  }

  .article-body :deep(h2)::before,
  .article-body :deep(h3)::before {
    display: none !important;
  }
}

/* ── Mobile ── */
@media (max-width: 900px) {
  .article-page__layout {
    grid-template-columns: 1fr;
  }

  .article-sidebar {
    display: none;
  }
}
</style>

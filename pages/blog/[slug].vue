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
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          {{ $t('article.backToBlog') }}
        </NuxtLink>

        <article v-if="article">
          <header class="article-header">
            <div class="article-meta">
              <time v-if="article.date" class="article-date mono" :datetime="article.date">
                {{ formatDate(article.date) }}
              </time>
              <span v-if="readingTime" class="article-readtime mono">
                {{ readingTime }} {{ $t('article.readingTime') }}
              </span>
            </div>
            <h1 class="article-title">{{ article.title }}</h1>
            <p v-if="article.description" class="article-description">
              {{ article.description }}
            </p>
            <div v-if="article.tags && article.tags.length" class="article-tags">
              <span v-for="tag in article.tags" :key="tag" class="tag tag--accent">
                {{ tag }}
              </span>
            </div>
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
        <div class="sidebar-actions">
          <button class="sidebar-btn" :class="{ active: focusMode }" :title="$t('article.focusMode')" @click="focusMode = !focusMode">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
            <span>{{ focusMode ? $t('article.exitFocus') : $t('article.focusMode') }}</span>
          </button>
          <button class="sidebar-btn" :title="$t('article.exportPdf')" @click="exportPdf">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z" /></svg>
            <span>{{ $t('article.exportPdf') }}</span>
          </button>
          <button class="sidebar-btn" :title="$t('article.exportMd')" @click="exportMarkdown">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 19h16" /></svg>
            <span>{{ $t('article.exportMd') }}</span>
          </button>
        </div>

        <nav v-if="toc.length" class="sidebar-toc">
          <p class="sidebar-toc__title">{{ $t('article.toc') }}</p>
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
  // headings may contain inline code: collect text from nested nodes too
  function textOf(node: any): string {
    if (node.value) return node.value
    return node.children?.map(textOf).join('') ?? ''
  }
  function walk(node: any) {
    if (!node) return
    if (['h2', 'h3', 'h4'].includes(node.tag)) {
      const text = textOf(node)
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
.article-page {
  padding: clamp(2rem, 5vw, 3.5rem) 0 5rem;
  min-height: 70vh;
}

.article-page__layout {
  display: grid;
  grid-template-columns: minmax(0, var(--measure)) 250px;
  justify-content: center;
  gap: 3.5rem;
  align-items: start;
}

.article-page__main {
  min-width: 0;
}

/* ── Back link ── */
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-2);
  text-decoration: none;
  margin-bottom: 2.25rem;
  transition: color var(--t-fast);
}

.back-link svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform var(--t-fast);
}

.back-link:hover {
  color: var(--accent);
}

.back-link:hover svg {
  transform: translateX(-3px);
}

/* ── Header ── */
.article-header {
  margin-bottom: 2.5rem;
  padding-bottom: 2rem;
  border-bottom: 1px solid var(--border);
}

.article-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.74rem;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

.article-readtime::before {
  content: '·';
  margin-right: 0.75rem;
}

.article-title {
  font-size: clamp(1.8rem, 1.3rem + 2.2vw, 2.8rem);
  font-weight: 740;
  letter-spacing: -0.035em;
  line-height: 1.1;
  margin-bottom: 1rem;
}

.article-description {
  color: var(--text-2);
  font-size: 1.08rem;
  line-height: 1.6;
  margin-bottom: 1.25rem;
}

.article-tags {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

/* ── Body ── */
.article-body {
  font-size: 1.02rem;
}

.article-body :deep(h2),
.article-body :deep(h3),
.article-body :deep(h4) {
  margin-top: 2.5rem;
  margin-bottom: 0.8rem;
  font-weight: 680;
  letter-spacing: -0.02em;
  line-height: 1.25;
  scroll-margin-top: calc(var(--header-h) + 1rem);
}

.article-body :deep(h2) { font-size: 1.5rem; }
.article-body :deep(h3) { font-size: 1.2rem; }
.article-body :deep(h4) { font-size: 1.05rem; }

.article-body :deep(h2 a),
.article-body :deep(h3 a),
.article-body :deep(h4 a) {
  color: inherit;
  text-decoration: none;
}

.article-body :deep(p) {
  margin-bottom: 1.3rem;
  color: var(--text-2);
  line-height: 1.8;
}

.article-body :deep(strong) {
  color: var(--text);
  font-weight: 640;
}

.article-body :deep(ul),
.article-body :deep(ol) {
  margin: 0 0 1.3rem 1.4rem;
  color: var(--text-2);
  line-height: 1.8;
}

.article-body :deep(li) {
  margin-bottom: 0.35rem;
  padding-left: 0.2rem;
}

.article-body :deep(li::marker) {
  color: var(--accent);
}

.article-body :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
  text-underline-offset: 3px;
  transition: text-decoration-color var(--t-fast);
}

.article-body :deep(a:hover) {
  text-decoration-color: var(--accent);
}

/* inline code only — block code is handled by ProseCode.vue */
.article-body :deep(code) {
  background: var(--inline-code-bg);
  color: var(--inline-code-fg);
  padding: 0.15em 0.45em;
  font-size: 0.86em;
  font-family: var(--font-mono);
  border-radius: 6px;
}

.article-body :deep(pre code) {
  background: transparent !important;
  color: inherit !important;
  padding: 0 !important;
  font-size: inherit !important;
}

.article-body :deep(blockquote) {
  border-left: 3px solid var(--accent);
  background: var(--surface);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: 0.9rem 1.2rem;
  margin: 1.5rem 0;
}

.article-body :deep(blockquote p:last-child) {
  margin-bottom: 0;
}

.article-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2.5rem 0;
}

.article-body :deep(img) {
  border-radius: var(--radius);
  border: 1px solid var(--border);
  margin: 1.5rem 0;
}

/* ── Tables ── */
.article-body :deep(table) {
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1.5rem;
  font-size: 0.86rem;
  white-space: nowrap;
}

.article-body :deep(thead th) {
  background: var(--surface-hover);
  color: var(--text);
  padding: 0.6rem 0.9rem;
  text-align: left;
  font-weight: 600;
  border-bottom: 1px solid var(--border-strong);
}

.article-body :deep(tbody td) {
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  vertical-align: middle;
}

.article-body :deep(tbody tr:hover td) {
  background: var(--surface);
}

.not-found {
  color: var(--text-3);
}

/* ── Sidebar ── */
.article-sidebar {
  position: sticky;
  top: calc(var(--header-h) + 1.5rem);
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  transition: opacity var(--t-med);
}

.article-sidebar--focus {
  opacity: 0;
  pointer-events: none;
}

.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(14px);
}

.sidebar-btn {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.65rem;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--t-fast), color var(--t-fast);
}

.sidebar-btn svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sidebar-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.sidebar-btn.active {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ── Table of contents ── */
.sidebar-toc {
  padding: 0 0.5rem;
}

.sidebar-toc__title {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.6rem;
}

.sidebar-toc__list {
  list-style: none;
  border-left: 1px solid var(--border);
}

.sidebar-toc__link {
  display: block;
  font-size: 0.8rem;
  color: var(--text-3);
  text-decoration: none;
  padding: 0.28rem 0.75rem;
  margin-left: -1px;
  border-left: 2px solid transparent;
  line-height: 1.45;
  word-break: break-word;
  transition: color var(--t-fast), border-color var(--t-fast);
}

.sidebar-toc__link:hover {
  color: var(--text);
}

.sidebar-toc__item.active .sidebar-toc__link {
  color: var(--accent);
  border-left-color: var(--accent);
}

.toc-depth-3 .sidebar-toc__link { padding-left: 1.4rem; }
.toc-depth-4 .sidebar-toc__link { padding-left: 2.1rem; }

/* ── Focus mode ── */
.focus-overlay {
  position: fixed;
  inset: 0;
  background: rgba(3, 5, 10, 0.7);
  backdrop-filter: blur(6px);
  z-index: 10;
  cursor: pointer;
}

.article-page--focus .article-page__main {
  position: relative;
  z-index: 11;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.6);
  padding: clamp(1.25rem, 4vw, 2.5rem);
}

/* ── Print ── */
@media print {
  .article-sidebar,
  .focus-overlay,
  .back-link {
    display: none !important;
  }

  .article-page {
    padding: 0 !important;
  }

  .article-page__layout {
    display: block !important;
  }
}

/* ── Mobile ── */
@media (max-width: 900px) {
  .article-page__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .article-sidebar {
    display: none;
  }
}
</style>

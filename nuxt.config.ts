// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: true,

  site: {
    url: 'https://www.mrdevrobot.com',
    name: 'MrDevRobot'
  },

  app: {
    head: {
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1',
      titleTemplate: '%s · MrDevRobot',
      meta: [
        { name: 'author', content: 'Luca Fabbri' },
        { property: 'og:site_name', content: 'MrDevRobot' },
        { name: 'twitter:card', content: 'summary_large_image' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'shortcut icon', href: '/favicon.svg' },
        { rel: 'apple-touch-icon', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap'
        }
      ]
    }
  },

  nitro: {
    prerender: {
      crawlLinks: true
    }
  },

  modules: [
    '@nuxt/content',
    '@nuxtjs/i18n',
    '@nuxtjs/sitemap'
  ],

  sitemap: {
    strictNuxtContentPaths: true
  },

  i18n: {
    locales: [
      { code: 'it', language: 'it-IT', name: 'Italiano', file: 'it.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' }
    ],
    defaultLocale: 'en',
    strategy: 'prefix_except_default',
    lazy: true,
    langDir: 'locales/',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_redirected',
      redirectOn: 'root'
    }
  },

  content: {
    highlight: {
      theme: 'github-dark'
    }
  },

  compatibilityDate: '2025-01-01'
})

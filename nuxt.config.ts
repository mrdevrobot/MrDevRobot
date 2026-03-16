// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: true,

  nitro: {
    prerender: {
      crawlLinks: true
    }
  },

  modules: [
    '@nuxt/content',
    '@nuxtjs/i18n'
  ],

  i18n: {
    locales: [
      { code: 'it', language: 'it-IT', name: 'Italiano', file: 'it.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' }
    ],
    defaultLocale: 'it',
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

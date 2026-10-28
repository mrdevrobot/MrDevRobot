// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: true,

  site: {
    url: 'https://www.mrdevrobot.com',
    name: 'MrDevRobot'
  },

  css: ['~/assets/css/main.css'],

  app: {
    head: {
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      titleTemplate: '%s · MrDevRobot',
      meta: [
        { name: 'author', content: 'Luca Fabbri' },
        { name: 'theme-color', content: '#07090f', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#f5f7fb', media: '(prefers-color-scheme: light)' },
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
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=JetBrains+Mono:wght@400;500&display=swap'
        }
      ],
      script: [
        {
          // Applies the saved/system theme before first paint to avoid a flash
          innerHTML: `(function(){try{var s=localStorage.getItem('theme');var m=window.matchMedia('(prefers-color-scheme: light)').matches;document.documentElement.dataset.theme=(s==='light'||s==='dark')?s:(m?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}})()`,
          tagPosition: 'head'
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
      theme: {
        default: 'github-light',
        dark: 'one-dark-pro'
      },
      langs: ['csharp', 'typescript', 'javascript', 'bash', 'json', 'yaml', 'css', 'html', 'markdown', 'sql', 'xml']
    }
  },

  compatibilityDate: '2025-01-01'
})

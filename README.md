# MrDevRobot Blog

Blog personale di [MrDevRobot](https://mrdevrobot.com) — articoli su sviluppo software, Vue, Nuxt e molto altro.

Built with [Nuxt 3](https://nuxt.com) + [Nuxt Content](https://content.nuxt.com) — sito statico con supporto multilingua (Italiano 🇮🇹 / English 🇬🇧).

---

## 🚀 Getting Started

### Install dependencies

```bash
npm install
```

### Development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Generate static site

```bash
npm run generate
```

The static files will be output to the `.output/public/` directory.

### Preview the generated site

```bash
npm run preview
```

---

## 📂 Project Structure

```
mrdevrobot/
├── content/
│   ├── it/blog/        # Italian articles (Markdown)
│   └── en/blog/        # English articles (Markdown)
├── locales/
│   ├── it.json         # Italian UI translations
│   └── en.json         # English UI translations
├── layouts/
│   └── default.vue     # Site layout (header + footer)
├── components/
│   ├── ArticleCard.vue      # Article preview card
│   └── LanguageSwitcher.vue # IT/EN switcher
├── pages/
│   ├── index.vue            # Homepage
│   ├── blog/index.vue       # Blog listing
│   └── blog/[slug].vue      # Single article
├── public/
│   └── CNAME               # Custom domain (mrdevrobot.com)
└── nuxt.config.ts
```

## ✍️ Writing Articles

Create a `.md` file inside `content/it/blog/` (Italian) or `content/en/blog/` (English).

Each file must have the following frontmatter:

```markdown
---
title: "Article Title"
description: "Short description"
date: "2026-03-16"
tags: ["nuxt", "vue"]
---

Your content here...
```

The filename (without `.md`) becomes the article slug:
- `content/it/blog/my-article.md` → `https://mrdevrobot.com/blog/my-article`
- `content/en/blog/my-article.md` → `https://mrdevrobot.com/en/blog/my-article`

---

## 🌍 Multilanguage Support

| URL Pattern | Language |
|---|---|
| `/` | Italian (default) |
| `/blog` | Italian blog listing |
| `/blog/[slug]` | Italian article |
| `/en/` | English |
| `/en/blog` | English blog listing |
| `/en/blog/[slug]` | English article |

The language switcher in the header lets visitors toggle between **IT** and **EN**.

---

## 🌐 Domain

The site is deployed at [mrdevrobot.com](https://mrdevrobot.com). The `public/CNAME` file configures the custom domain for GitHub Pages.


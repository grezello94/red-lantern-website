const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = String(match[2] || '').replace(/^["']|["']$/g, '').trim();
    });
}

const multer = require('multer');
const { neon } = require('@neondatabase/serverless');

function cleanEnvUrl(name) {
  if (!process.env[name]) return '';
  const cleanValue = process.env[name]
    .replace(/^["']|["']$/g, '')
    .trim()
    .replace(/^=+/, '');
  process.env[name] = cleanValue;
  return cleanValue;
}

if (process.env.CLOUDINARY_URL) {
  const cleanCloudinaryUrl = cleanEnvUrl('CLOUDINARY_URL');
  if (cleanCloudinaryUrl.startsWith('cloudinary://')) {
    process.env.CLOUDINARY_URL = cleanCloudinaryUrl;
  } else {
    console.warn("Invalid CLOUDINARY_URL format. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME");
    delete process.env.CLOUDINARY_URL;
  }
}

const cloudinary = require('cloudinary').v2;

if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    api_key: process.env.CLOUDINARY_API_KEY.trim(),
    api_secret: process.env.CLOUDINARY_API_SECRET.trim(),
    secure: true
  });
} else if (process.env.CLOUDINARY_URL) {
  const cleanUrl = process.env.CLOUDINARY_URL.replace(/^["']|["']$/g, '').trim();
  const match = cleanUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (match) {
    cloudinary.config({
      api_key: match[1].trim(),
      api_secret: match[2].trim(),
      cloud_name: match[3].trim(),
      secure: true
    });
  } else {
    console.warn("⚠️ CLOUDINARY_URL format looks incorrect. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME");
  }
}

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

let sql = null;
const neonDatabaseUrl = cleanEnvUrl('NEON_DATABASE_URL');
if (neonDatabaseUrl) {
  if (neonDatabaseUrl.startsWith('postgresql://') || neonDatabaseUrl.startsWith('postgres://')) {
    try {
      sql = neon(neonDatabaseUrl);
    } catch (error) {
      console.warn('Neon URL format is invalid. Admin saves are disabled until NEON_DATABASE_URL is fixed.');
    }
  } else {
    console.warn('Neon URL format is invalid. It should start with postgresql:// or postgres://. Admin saves are disabled until NEON_DATABASE_URL is fixed.');
  }
} else {
  console.warn('Neon URL not found. Admin page will load, but saving changes is disabled.');
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 6 * 1024 * 1024,
    files: 12
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }
    return cb(null, true);
  }
});

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  next();
}

function secureCompare(a = '', b = '') {
  const aHash = crypto.createHash('sha256').update(String(a)).digest();
  const bHash = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isProtectedAdminPath(req) {
  return req.path === '/admin'
    || req.path === '/admin.html'
    || req.path === '/admin-cms.js'
    || req.path === '/api/admin/content'
    || req.path.startsWith('/api/update-')
    || req.path === '/api/growth-ai';
}

const adminAttempts = new Map();
const maxAdminFailures = 8;
const adminLockMs = 15 * 60 * 1000;

function adminAttemptKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function isAdminLocked(req) {
  const key = adminAttemptKey(req);
  const entry = adminAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.lockUntil) {
    adminAttempts.delete(key);
    return false;
  }
  return entry.failures >= maxAdminFailures;
}

function recordAdminFailure(req) {
  const key = adminAttemptKey(req);
  const entry = adminAttempts.get(key) || { failures: 0, lockUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= maxAdminFailures) entry.lockUntil = Date.now() + adminLockMs;
  adminAttempts.set(key, entry);
}

function clearAdminFailures(req) {
  adminAttempts.delete(adminAttemptKey(req));
}

function requireAdmin(req, res, next) {
  if (!isProtectedAdminPath(req)) return next();

  if (isAdminLocked(req)) {
    return res.status(429).send('Too many failed login attempts. Try again later.');
  }

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    console.error('Admin access is disabled because ADMIN_USERNAME or ADMIN_PASSWORD is missing.');
    return res.status(503).send('Admin access is not configured.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Red Lantern Admin", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  }

  const [username, ...passwordParts] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  const password = passwordParts.join(':');
  if (secureCompare(username, expectedUser) && secureCompare(password, expectedPass)) {
    clearAdminFailures(req);
    return next();
  }

  recordAdminFailure(req);
  res.set('WWW-Authenticate', 'Basic realm="Red Lantern Admin", charset="UTF-8"');
  return res.status(401).send('Invalid username or password.');
}

function blockSensitiveFiles(req, res, next) {
  let requestPath = req.path;
  try {
    requestPath = decodeURIComponent(req.path).replace(/\\/g, '/');
  } catch {
    return res.status(400).send('Bad request.');
  }
  const basename = path.basename(requestPath);
  const blockedRoots = ['/.git', '/.netlify', '/.vercel', '/node_modules'];
  const blockedFiles = new Set([
    '.env',
    '.env.local',
    '.env.example',
    '.gitignore',
    'server.js',
    'init-db.js',
    'package.json',
    'package-lock.json',
    'deno.lock',
    'netlify.toml',
    'vercel.json',
    'claude-install.ps1'
  ]);

  if (blockedRoots.some((root) => requestPath === root || requestPath.startsWith(`${root}/`))
    || blockedFiles.has(basename)) {
    return res.status(404).send('Not found.');
  }

  return next();
}

app.use(securityHeaders);
app.use(requireAdmin);
app.use(blockSensitiveFiles);
app.use(express.static(__dirname, {
  dotfiles: 'deny',
  index: false,
  maxAge: '1h'
}));
app.use('/uploads', express.static(uploadsDir, {
  dotfiles: 'deny',
  index: false,
  maxAge: '7d'
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const collections = {
  home: 'home_content',
  menu: 'menu_content',
  about: 'about_content',
  blogs: 'blogs_content',
  contact: 'contact_content',
  global: 'global_content'
};

const labels = {
  home: 'Home Page',
  menu: 'Menu Page',
  about: 'About Page',
  blogs: 'Blogs Page',
  contact: 'Contact Page',
  global: 'Global Settings'
};

const asArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const slugify = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || `post-${Date.now()}`;

const firstFile = (files, name) => {
  const file = files.find((item) => item.fieldname === name);
  return file ? file.publicUrl : '';
};

const indexedFile = (files, name, index) => {
  const file = files.find((item) => item.fieldname === `${name}_${index}`);
  return file ? file.publicUrl : '';
};

async function getSection(section) {
  if (!sql) return {};
  try {
    const rows = await sql`SELECT data FROM website_content WHERE id = ${collections[section]}`;
    return rows.length ? rows[0].data || {} : {};
  } catch (err) {
    console.error('Neon DB Error:', err);
    return {};
  }
}

async function saveSection(section, data) {
  if (!sql) throw new Error('Neon is not configured. Add NEON_DATABASE_URL to your .env file.');
  const existing = await getSection(section);
  const merged = { ...existing, ...data };
  await sql`
    INSERT INTO website_content (id, data) 
    VALUES (${collections[section]}, ${merged})
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
  `;
}

function normalizeHome(body, files) {
  const reviewNames = asArray(body.reviewName);
  const reviewStars = asArray(body.reviewStars);
  const reviewTexts = asArray(body.reviewText);

  return {
    heroTitle: body.heroTitle,
    heroSubtitle: body.heroSubtitle,
    heroImage: firstFile(files, 'heroImage') || body.currentHeroImage || '',
    welcomeTitle: body.welcomeTitle,
    welcomeText: body.welcomeText,
    welcomeImage: firstFile(files, 'welcomeImage') || body.currentWelcomeImage || '',
    featureOneTitle: body.featureOneTitle,
    featureOneText: body.featureOneText,
    featureTwoTitle: body.featureTwoTitle,
    featureTwoText: body.featureTwoText,
    featureThreeTitle: body.featureThreeTitle,
    featureThreeText: body.featureThreeText,
    blogSectionTitle: body.blogSectionTitle,
    blogSectionSubtitle: body.blogSectionSubtitle,
    reviews: reviewNames.map((name, index) => ({
      name,
      stars: reviewStars[index] || '★★★★★',
      text: reviewTexts[index] || ''
    })).filter((review) => review.name || review.text)
  };
}

function normalizeMenu(body, files) {
  const names = asArray(body.dishName);
  const prices = asArray(body.dishPrice);
  const descriptions = asArray(body.dishDesc);
  const categories = asArray(body.dishCategory);
  const badges = asArray(body.dishBadge);
  const currentImages = asArray(body.currentDishImage);

  return {
    pageTitle: body.menuPageTitle || 'Our Menu',
    pageSubtitle: body.menuPageSubtitle || 'Explore our diverse selection of authentic Chinese and Goan dishes.',
    note: body.menuNote || 'Menu availability may vary. Please call us for pricing and daily specials.',
    dishes: names.map((name, index) => ({
      name,
      price: prices[index] || '',
      description: descriptions[index] || '',
      category: categories[index] || 'Signature Dishes',
      badge: badges[index] || '',
      image: indexedFile(files, 'dishPhoto', index) || currentImages[index] || ''
    })).filter((dish) => dish.name)
  };
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function readTimeMinutes(value) {
  const words = stripHtml(value).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function formatBlogDate(value) {
  const timestamp = indiaScheduleTime(value) || Date.now();
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  }).format(new Date(timestamp));
}

function blogMetaFromSchedule(publishAt, content) {
  return `${formatBlogDate(publishAt)} · ${readTimeMinutes(content)} min read`;
}

function normalizeBlogs(body, files) {
  const titles = asArray(body.blogTitle);
  const excerpts = asArray(body.blogExcerpt);
  const contents = asArray(body.blogContent);
  const seoTitles = asArray(body.blogSeoTitle);
  const seoDescriptions = asArray(body.blogSeoDescription);
  const publishAts = asArray(body.blogPublishAt);
  const currentImages = asArray(body.currentBlogImage);

  return {
    pageTitle: body.blogPageTitle || 'Red Lantern Journal',
    pageSubtitle: body.blogPageSubtitle || 'Stories, recipes, and local guides from South Goa.',
    posts: titles.map((title, index) => ({
      title,
      slug: slugify(title),
      publishAt: publishAts[index] || '',
      meta: blogMetaFromSchedule(publishAts[index], contents[index] || excerpts[index] || ''),
      excerpt: excerpts[index] || '',
      content: contents[index] || '',
      image: indexedFile(files, 'blogImage', index) || currentImages[index] || '',
      seoTitle: seoTitles[index] || title,
      seoDescription: seoDescriptions[index] || excerpts[index] || ''
    })).filter((post) => post.title)
  };
}

function normalizeAbout(body, files) {
  return {
    heroTitle: body.aboutHeroTitle,
    heroSubtitle: body.aboutHeroSubtitle,
    storyTitle: body.aboutStoryTitle,
    storyText: body.aboutStoryText,
    heroImage: firstFile(files, 'aboutHeroImage') || '',
    storyImage: firstFile(files, 'aboutStoryImage') || ''
  };
}

function normalizeGlobal(body) {
  return {
    footerDescription: body.footerDescription,
    zomatoUrl: body.zomatoUrl,
    swiggyUrl: body.swiggyUrl,
    siteUrl: body.siteUrl,
    seoTitle: body.seoTitle,
    seoDescription: body.seoDescription,
    seoKeywords: body.seoKeywords,
    ogImage: body.ogImage,
    instagramUrl: body.instagramUrl,
    googleBusinessUrl: body.googleBusinessUrl,
    gaMeasurementId: body.gaMeasurementId,
    googleAdsId: body.googleAdsId,
    googleCallConversionLabel: body.googleCallConversionLabel,
    googleOrderConversionLabel: body.googleOrderConversionLabel,
    googleDirectionsConversionLabel: body.googleDirectionsConversionLabel,
    metaPixelId: body.metaPixelId,
    targetLocations: body.targetLocations,
    targetCuisines: body.targetCuisines,
    competitorNames: body.competitorNames,
    competitorResearchNotes: body.competitorResearchNotes
  };
}

function normalizeContact(body) {
  return {
    address: body.address,
    hours: body.hours,
    phone: body.phone,
    email: body.email,
    mapEmbedUrl: body.mapEmbedUrl
  };
}

function normalizeSection(section, body, files) {
  if (section === 'home') return normalizeHome(body, files);
  if (section === 'menu') return normalizeMenu(body, files);
  if (section === 'blogs') return normalizeBlogs(body, files);
  if (section === 'about') return normalizeAbout(body, files);
  if (section === 'global') return normalizeGlobal(body);
  if (section === 'contact') return normalizeContact(body);
  return body;
}

const indiaOffsetMinutes = 5.5 * 60;

function indiaScheduleTime(value) {
  if (!value) return 0;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - (indiaOffsetMinutes * 60 * 1000);
}

function publishedPosts(posts = [], now = Date.now()) {
  return posts.filter((post) => !post.publishAt || indiaScheduleTime(post.publishAt) <= now);
}

function filterScheduledBlogs(blogs = {}) {
  return {
    ...blogs,
    posts: publishedPosts(blogs.posts || [])
  };
}

async function getAllContent(includeScheduled = false) {
  const entries = await Promise.all(Object.keys(collections).map(async (section) => [section, await getSection(section)]));
  const content = Object.fromEntries(entries);
  if (!includeScheduled && content.blogs) content.blogs = filterScheduledBlogs(content.blogs);
  return content;
}

function trimForPrompt(content) {
  const global = content.global || {};
  const contact = content.contact || {};
  const menu = content.menu || {};
  const blogs = content.blogs || {};

  return {
    business: {
      name: 'Red Lantern Restaurant',
      location: contact.address || 'Colva, South Goa',
      hours: contact.hours || '',
      phone: contact.phone || '',
      website: global.siteUrl || '',
      orderLinks: {
        zomato: global.zomatoUrl || '',
        swiggy: global.swiggyUrl || ''
      }
    },
    seo: {
      title: global.seoTitle || '',
      description: global.seoDescription || '',
      keywords: global.seoKeywords || '',
      targetLocations: global.targetLocations || '',
      targetSearches: global.targetCuisines || '',
      competitors: global.competitorNames || '',
      researchNotes: global.competitorResearchNotes || ''
    },
    menu: {
      pageTitle: menu.pageTitle || '',
      pageSubtitle: menu.pageSubtitle || '',
      dishes: (menu.dishes || []).slice(0, 20).map((dish) => ({
        name: dish.name || '',
        category: dish.category || '',
        badge: dish.badge || '',
        description: dish.description || ''
      }))
    },
    blogs: {
      count: (blogs.posts || []).length,
      posts: (blogs.posts || []).slice(0, 12).map((post) => ({
        title: post.title || '',
        slug: post.slug || '',
        excerpt: post.excerpt || '',
        seoTitle: post.seoTitle || '',
        seoDescription: post.seoDescription || ''
      }))
    }
  };
}

function parseAiJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function generateAiGrowthPlan(content) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing OPENAI_API_KEY. Add it to a local .env file or server environment to enable real AI growth ideas.');
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_GROWTH_MODEL || 'gpt-5';
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'low' },
      tools: [{
        type: 'web_search',
        user_location: {
          type: 'approximate',
          country: 'IN',
          city: 'Colva',
          region: 'Goa',
          timezone: 'Asia/Kolkata'
        }
      }],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      max_output_tokens: 2200,
      text: {
        format: {
          type: 'json_schema',
          name: 'restaurant_growth_plan',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              trendSignals: {
                type: 'array',
                minItems: 3,
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    priority: { type: 'string' }
                  },
                  required: ['title', 'detail', 'priority']
                }
              },
              priorityActions: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    impact: { type: 'string' }
                  },
                  required: ['title', 'detail', 'impact']
                }
              },
              seoWinningMoves: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    searchTarget: { type: 'string' }
                  },
                  required: ['title', 'detail', 'searchTarget']
                }
              },
              contentIdeas: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    searchIntent: { type: 'string' },
                    outline: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'searchIntent', 'outline', 'keywords']
                }
              },
              adIdeas: {
                type: 'array',
                minItems: 3,
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    campaign: { type: 'string' },
                    audience: { type: 'string' },
                    message: { type: 'string' },
                    landingPage: { type: 'string' }
                  },
                  required: ['campaign', 'audience', 'message', 'landingPage']
                }
              },
              missingWebsiteItems: {
                type: 'array',
                minItems: 3,
                maxItems: 8,
                items: { type: 'string' }
              },
              sources: {
                type: 'array',
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' }
                  },
                  required: ['title', 'url']
                }
              }
            },
            required: ['summary', 'trendSignals', 'priorityActions', 'seoWinningMoves', 'contentIdeas', 'adIdeas', 'missingWebsiteItems', 'sources']
          }
        }
      },
      instructions: 'You are a senior local SEO and restaurant growth strategist. Your primary objective is to help the restaurant compete for top visibility in Google Maps/local pack and organic food searches. Use live web search when helpful. Give practical actions for ranking and conversions, but never guarantee first-page ranking. Return only valid JSON matching the schema.',
      input: `Today is ${today}. Create a current SEO-first growth plan for this restaurant to compete for food and restaurant searches around Colva and South Goa. Prioritize: Google Business Profile/local pack visibility, high-intent landing pages, menu SEO, blog topic clusters, review strategy, competitor positioning, technical/schema improvements, and measurable conversion tracking. Use the website/CMS data below, competitor inputs, and current search/travel/food trends. Be specific and action-oriented.\n\nCMS data:\n${JSON.stringify(trimForPrompt(content), null, 2)}`
    })
  });

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || 'OpenAI request failed.');
    error.statusCode = response.status;
    throw error;
  }

  return parseAiJson(body.output_text);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/content', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getAllContent());
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/content', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getAllContent(true));
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/content/:section', async (req, res) => {
  if (!collections[req.params.section]) return res.status(404).json({ error: 'Unknown content section.' });

  try {
    res.set('Cache-Control', 'no-store');
    const section = await getSection(req.params.section);
    res.json(req.params.section === 'blogs' ? filterScheduledBlogs(section) : section);
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/blogs/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const blogs = await getSection('blogs');
    const post = publishedPosts(blogs.posts || []).find((item) => item.slug === req.params.slug);
    if (!post) return res.status(404).json({ error: 'Blog post not found.' });
    res.json(post);
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

const xmlEscape = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const absoluteSiteUrl = (url, siteUrl) => {
  try {
    return new URL(url, siteUrl).href;
  } catch {
    return url;
  }
};

function publicSiteUrl(req, global = {}) {
  const configured = String(global.siteUrl || '').trim().replace(/\/$/, '');
  if (configured && !configured.includes('localhost')) return configured;

  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (hostValue && !String(hostValue).includes('localhost')) {
    const protoHeader = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    return `${proto || 'https'}://${hostValue}`.replace(/\/$/, '');
  }

  return `http://localhost:${port}`;
}

app.get('/sitemap.xml', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const global = await getSection('global');
  const menu = await getSection('menu');
  const blogs = filterScheduledBlogs(await getSection('blogs'));
  const siteUrl = publicSiteUrl(req, global);
  const today = new Date().toISOString().slice(0, 10);
  const menuImages = (menu.dishes || [])
    .filter((dish) => dish.image)
    .map((dish) => ({
      loc: absoluteSiteUrl(dish.image, siteUrl),
      title: `${dish.name} at Red Lantern Restaurant in Colva`
    }));
  const urls = [
    { loc: `${siteUrl}/`, priority: '1.0', changefreq: 'weekly', images: [global.ogImage ? { loc: absoluteSiteUrl(global.ogImage, siteUrl), title: 'Red Lantern Restaurant in Colva Goa' } : null].filter(Boolean) },
    { loc: `${siteUrl}/menu.html`, priority: '0.9', changefreq: 'weekly', images: menuImages },
    { loc: `${siteUrl}/contact.html`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${siteUrl}/about.html`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${siteUrl}/blogs.html`, priority: '0.7', changefreq: 'weekly' }
  ];
  (blogs.posts || []).forEach((post) => {
    urls.push({
      loc: `${siteUrl}/blog-post.html?slug=${encodeURIComponent(post.slug)}`,
      priority: '0.6',
      changefreq: 'monthly',
      images: post.image ? [{ loc: absoluteSiteUrl(post.image, siteUrl), title: post.title }] : []
    });
  });

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((url) => `  <url><loc>${xmlEscape(url.loc)}</loc><lastmod>${today}</lastmod><changefreq>${url.changefreq}</changefreq><priority>${url.priority}</priority>${(url.images || []).map((image) => `<image:image><image:loc>${xmlEscape(image.loc)}</image:loc><image:title>${xmlEscape(image.title)}</image:title></image:image>`).join('')}</url>`).join('\n')}
</urlset>`);
});

app.get('/rss.xml', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const global = await getSection('global');
  const blogs = filterScheduledBlogs(await getSection('blogs'));
  const siteUrl = publicSiteUrl(req, global);
  const posts = blogs.posts || [];

  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(blogs.pageTitle || 'Red Lantern Journal')}</title>
    <link>${xmlEscape(`${siteUrl}/blogs.html`)}</link>
    <description>${xmlEscape(blogs.pageSubtitle || 'Food guides, restaurant stories, and menu updates from Red Lantern Restaurant in Colva, Goa.')}</description>
    <language>en-IN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${posts.map((post) => `<item><title>${xmlEscape(post.title)}</title><link>${xmlEscape(`${siteUrl}/blog-post.html?slug=${encodeURIComponent(post.slug)}`)}</link><guid>${xmlEscape(`${siteUrl}/blog-post.html?slug=${encodeURIComponent(post.slug)}`)}</guid><description>${xmlEscape(post.seoDescription || post.excerpt || '')}</description></item>`).join('\n    ')}
  </channel>
</rss>`);
});

app.post('/api/growth-ai', async (req, res) => {
  try {
    const content = await getAllContent();
    const plan = await generateAiGrowthPlan(content);
    res.json({
      generatedAt: new Date().toISOString(),
      plan
    });
  } catch (error) {
    console.error('AI growth error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

Object.keys(collections).forEach((section) => {
  app.post(`/api/update-${section}`, upload.any(), async (req, res) => {
    try {
      if (req.files && req.files.length > 0) {
        if (!process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_API_KEY) {
           console.warn("Missing CLOUDINARY_URL, images will not be uploaded to cloud.");
           throw new Error('Cloudinary is not configured. Add credentials to your .env file.');
        }
        const cConfig = cloudinary.config();
        if (!cConfig.api_key) {
           throw new Error(`Cloudinary API Key is missing! Found Cloud Name: ${cConfig.cloud_name ? 'Yes' : 'No'}.`);
        }

        for (const file of req.files) {
          const safeBase = path
            .basename(file.originalname, path.extname(file.originalname))
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();
          const filename = `${Date.now()}-${safeBase}`;
          const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { 
                folder: 'red_lantern_uploads', 
                public_id: filename, 
                resource_type: 'image',
                format: 'webp',
                transformation: [
                  {
                    width: 1600,
                    height: 1600,
                    crop: 'limit',
                    quality: 'auto:good'
                  }
                ],
                api_key: cConfig.api_key,
                api_secret: cConfig.api_secret,
                cloud_name: cConfig.cloud_name
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            stream.end(file.buffer);
          });

          file.publicUrl = result.secure_url;
        }
      }
      await saveSection(section, normalizeSection(section, req.body, req.files || []));
      res.send(`<h2>Success!</h2><p>${labels[section]} changes saved to Neon.</p><a href="/admin">Go Back to Dashboard</a>`);
    } catch (error) {
      console.error('Save error:', error);
      res.status(500).send('Database error: ' + error.message);
    }
  });
});

// Only start server automatically if not running in a Vercel serverless environment
if (!process.env.VERCEL) {
  const server = app.listen(port, host, () => {
    console.log(`Red Lantern backend running on ${host}:${port}`);
  });

  server.on('error', (error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

module.exports = app;

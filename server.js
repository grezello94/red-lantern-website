const express = require('express');
const path = require('path');
const fs = require('fs');

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

if (process.env.CLOUDINARY_URL) {
  const cleanCloudinaryUrl = process.env.CLOUDINARY_URL.replace(/^["']|["']$/g, '').trim();
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
const port = process.env.PORT || 3001;
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

let sql = null;
if (process.env.NEON_DATABASE_URL) {
  sql = neon(process.env.NEON_DATABASE_URL);
} else {
  console.warn('Neon URL not found. Admin page will load, but saving changes is disabled.');
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

const fileList = (files, name) => files
  .filter((item) => item.fieldname === name)
  .map((file) => file.publicUrl);

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
  const uploadedPhotos = fileList(files, 'dishPhoto');

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
      image: uploadedPhotos[index] || ''
    })).filter((dish) => dish.name)
  };
}

function normalizeBlogs(body, files) {
  const titles = asArray(body.blogTitle);
  const metas = asArray(body.blogMeta);
  const excerpts = asArray(body.blogExcerpt);
  const contents = asArray(body.blogContent);
  const seoTitles = asArray(body.blogSeoTitle);
  const seoDescriptions = asArray(body.blogSeoDescription);
  const uploadedImages = fileList(files, 'blogImage');

  return {
    pageTitle: body.blogPageTitle || 'Red Lantern Journal',
    pageSubtitle: body.blogPageSubtitle || 'Stories, recipes, and local guides from South Goa.',
    posts: titles.map((title, index) => ({
      title,
      slug: slugify(title),
      meta: metas[index] || '',
      excerpt: excerpts[index] || '',
      content: contents[index] || '',
      image: uploadedImages[index] || '',
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

async function getAllContent() {
  const entries = await Promise.all(Object.keys(collections).map(async (section) => [section, await getSection(section)]));
  return Object.fromEntries(entries);
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
    res.json(await getAllContent());
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/content/:section', async (req, res) => {
  if (!collections[req.params.section]) return res.status(404).json({ error: 'Unknown content section.' });

  try {
    res.json(await getSection(req.params.section));
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/blogs/:slug', async (req, res) => {
  try {
    const blogs = await getSection('blogs');
    const post = (blogs.posts || []).find((item) => item.slug === req.params.slug);
    if (!post) return res.status(404).json({ error: 'Blog post not found.' });
    res.json(post);
  } catch (error) {
    console.error('Neon error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/sitemap.xml', async (req, res) => {
  const global = await getSection('global');
  const blogs = await getSection('blogs');
  const siteUrl = (global.siteUrl || `http://localhost:${port}`).replace(/\/$/, '');
  const urls = ['/', '/menu.html', '/about.html', '/blogs.html', '/contact.html']
    .map((url) => `${siteUrl}${url}`);
  (blogs.posts || []).forEach((post) => urls.push(`${siteUrl}/blog-post.html?slug=${post.slug}`));

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`);
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
                resource_type: 'auto',
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
  app.listen(port, () => {
    console.log(`Red Lantern backend running at http://localhost:${port}`);
  });
}

module.exports = app;

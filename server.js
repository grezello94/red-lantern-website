const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3001;
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const firebaseKeyPath = path.join(__dirname, 'firebase-key.json');
let db = null;

if (fs.existsSync(firebaseKeyPath)) {
  const serviceAccount = require(firebaseKeyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
} else {
  console.warn('Firebase key not found. Admin page will load, but saving changes is disabled.');
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, callback) => {
    const safeBase = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    callback(null, `${Date.now()}-${safeBase}${path.extname(file.originalname).toLowerCase()}`);
  }
});
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
  return file ? `/uploads/${file.filename}` : '';
};

const fileList = (files, name) => files
  .filter((item) => item.fieldname === name)
  .map((file) => `/uploads/${file.filename}`);

async function getSection(section) {
  if (!db) return {};
  const doc = await db.collection(collections[section]).doc('main').get();
  return doc.exists ? doc.data() : {};
}

async function saveSection(section, data) {
  if (!db) throw new Error('Firebase is not configured. Add firebase-key.json to enable saving.');
  await db.collection(collections[section]).doc('main').set(data, { merge: true });
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/content', async (req, res) => {
  try {
    const entries = await Promise.all(Object.keys(collections).map(async (section) => [section, await getSection(section)]));
    res.json(Object.fromEntries(entries));
  } catch (error) {
    console.error('Firebase error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/content/:section', async (req, res) => {
  if (!collections[req.params.section]) return res.status(404).json({ error: 'Unknown content section.' });

  try {
    res.json(await getSection(req.params.section));
  } catch (error) {
    console.error('Firebase error:', error);
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
    console.error('Firebase error:', error);
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

Object.keys(collections).forEach((section) => {
  app.post(`/api/update-${section}`, upload.any(), async (req, res) => {
    try {
      await saveSection(section, normalizeSection(section, req.body, req.files || []));
      res.send(`<h2>Success!</h2><p>${labels[section]} changes saved to Firebase.</p><a href="/admin">Go Back to Dashboard</a>`);
    } catch (error) {
      console.error('Firebase error:', error);
      res.status(500).send('Database error: ' + error.message);
    }
  });
});

app.listen(port, () => {
  console.log(`Red Lantern backend running at http://localhost:${port}`);
});

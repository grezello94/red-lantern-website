const setText = (element, value) => {
  if (element && value) element.textContent = value;
};

const setHtml = (element, value) => {
  if (element && value) element.innerHTML = value;
};

const phoneHref = (phone) => `tel:${phone.replace(/[^\d+]/g, '')}`;
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

const paragraphs = (value) => String(value || '')
  .split(/\n+/)
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => `<p>${escapeHtml(part)}</p>`)
  .join('');

const articleHtml = (value) => {
  const source = String(value || '').trim();
  if (!source) return '';
  if (!/<\/?[a-z][\s\S]*>/i.test(source)) return paragraphs(source);

  const template = document.createElement('template');
  template.innerHTML = source;
  const allowedTags = new Set(['A', 'BR', 'EM', 'H2', 'LI', 'OL', 'P', 'STRONG', 'UL']);

  template.content.querySelectorAll('*').forEach((node) => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(document.createTextNode(node.textContent || ''));
      return;
    }

    const href = node.tagName === 'A' ? node.getAttribute('href') || '' : '';
    [...node.attributes].forEach((attribute) => node.removeAttribute(attribute.name));
    if (node.tagName === 'A') {
      const safeHref = href.startsWith('https://') || href.startsWith('http://') || href.startsWith('/');
      if (safeHref) {
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else {
        node.removeAttribute('href');
      }
    }
  });

  return template.innerHTML;
};

const getSlug = () => new URLSearchParams(window.location.search).get('slug');
const indiaScheduleTime = (value) => {
  if (!value) return 0;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - (330 * 60 * 1000);
};
const publishedPosts = (posts = []) => posts.filter((post) => !post.publishAt || indiaScheduleTime(post.publishAt) <= Date.now());
let reviewRotationTimer = null;
const currentPage = () => {
  const file = location.pathname.split('/').pop() || 'index.html';
  return file === '' ? 'index.html' : file;
};
const absoluteUrl = (url, siteUrl = location.origin) => {
  if (!url) return '';
  try {
    return new URL(url, siteUrl).href;
  } catch {
    return url;
  }
};

function upsertMeta(selector, attributes) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    document.head.appendChild(element);
  }
  Object.entries(attributes).forEach(([key, value]) => {
    if (value) element.setAttribute(key, value);
  });
}

function upsertLink(selector, attributes) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement('link');
    document.head.appendChild(element);
  }
  Object.entries(attributes).forEach(([key, value]) => {
    if (value) element.setAttribute(key, value);
  });
}

function setPageSeo({ title, description, image, type = 'website' }, global = {}) {
  const siteUrl = (global.siteUrl || location.origin).replace(/\/$/, '');
  const pageUrl = absoluteUrl(location.pathname + location.search, siteUrl);
  const pageImage = absoluteUrl(image || global.ogImage || 'images/Redlanternlogo.png', siteUrl);

  if (title) document.title = title;
  upsertLink('link[rel="canonical"]', { rel: 'canonical', href: pageUrl });
  upsertMeta('meta[name="description"]', { name: 'description', content: description });
  upsertMeta('meta[property="og:type"]', { property: 'og:type', content: type });
  upsertMeta('meta[property="og:title"]', { property: 'og:title', content: title || document.title });
  upsertMeta('meta[property="og:description"]', { property: 'og:description', content: description });
  upsertMeta('meta[property="og:image"]', { property: 'og:image', content: pageImage });
  upsertMeta('meta[property="og:url"]', { property: 'og:url', content: pageUrl });
  upsertMeta('meta[name="twitter:card"]', { name: 'twitter:card', content: 'summary_large_image' });
  upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: title || document.title });
  upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: description });
  upsertMeta('meta[name="twitter:image"]', { name: 'twitter:image', content: pageImage });
}

function injectScript(src, id) {
  if (!src || document.getElementById(id)) return;
  const script = document.createElement('script');
  script.async = true;
  script.id = id;
  script.src = src;
  document.head.appendChild(script);
}

function updateActiveNav() {
  const page = currentPage();
  const activePage = page === 'blog-post.html' ? 'blogs.html' : page;

  document.querySelectorAll('.site-nav a:not(.call-button)').forEach((link) => {
    const linkPage = (link.getAttribute('href') || '').split('#')[0] || 'index.html';
    link.classList.toggle('is-active', linkPage === activePage);
  });
}

function applyContact(contact = {}) {
  setText(document.getElementById('contact-address'), contact.address);
  setText(document.getElementById('contact-phone'), contact.phone);
  setText(document.getElementById('contact-email'), contact.email);
  setText(document.getElementById('contact-hours'), contact.hours);
  setText(document.getElementById('footer-address'), contact.address);
  setText(document.getElementById('footer-phone'), contact.phone);
  setText(document.getElementById('footer-hours'), contact.hours);

  document.querySelectorAll('.info-bar .info-item span').forEach((item, index) => {
    if (index === 0) setText(item, contact.address);
    if (index === 1) setText(item, contact.hours);
  });

  document.querySelectorAll('.call-button, a[href^="tel:"]').forEach((link) => {
    if (contact.phone) link.href = phoneHref(contact.phone);
    if (contact.phone && link.textContent.includes('Call:')) link.textContent = `Call: ${contact.phone}`;
  });

  document.querySelectorAll('.footer-contact').forEach((footerContact) => {
    const textNodes = footerContact.querySelectorAll('p, .footer-contact-item span:last-child');
    setText(textNodes[0], contact.address);
    setText(textNodes[1], contact.phone);
    setText(textNodes[2], contact.hours);
  });

  if (contact.mapEmbedUrl) {
    const map = document.getElementById('contact-map');
    if (map) map.src = contact.mapEmbedUrl;
  }
}

function applyGlobal(global = {}) {
  if (currentPage() === 'index.html') {
    setPageSeo({
      title: global.seoTitle || 'Red Lantern Restaurant | Chinese & Goan Food in Colva, Goa',
      description: global.seoDescription || 'Red Lantern Restaurant in Colva, South Goa serves authentic Chinese, Goan seafood, and family-friendly dinner specials. View the menu, call, or order online.',
      image: global.ogImage
    }, global);
  } else {
    setPageSeo({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      image: global.ogImage
    }, global);
  }
  if (global.seoKeywords) upsertMeta('meta[name="keywords"]', { name: 'keywords', content: global.seoKeywords });

  document.querySelectorAll('.footer-brand p').forEach((item) => setText(item, global.footerDescription));
  document.querySelectorAll('a[href="#order-zomato"], a[href*="zomato.com"]').forEach((link) => {
    if (global.zomatoUrl) link.href = global.zomatoUrl;
  });
  document.querySelectorAll('a[href="#order-swiggy"], a[href*="swiggy.com"]').forEach((link) => {
    if (global.swiggyUrl) link.href = global.swiggyUrl;
  });
  setupTracking(global);
}

function setupTracking(global = {}) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag(){ window.dataLayer.push(arguments); };

  if (global.gaMeasurementId || global.googleAdsId) {
    injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(global.gaMeasurementId || global.googleAdsId)}`, 'google-tag');
    window.gtag('js', new Date());
    if (global.gaMeasurementId) window.gtag('config', global.gaMeasurementId);
    if (global.googleAdsId) window.gtag('config', global.googleAdsId);
  }

  if (global.metaPixelId && !window.fbq) {
    window.fbq = function fbq(){ window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments); };
    window.fbq.queue = [];
    window.fbq.loaded = true;
    window.fbq.version = '2.0';
    injectScript('https://connect.facebook.net/en_US/fbevents.js', 'meta-pixel');
    window.fbq('init', global.metaPixelId);
    window.fbq('track', 'PageView');
  }

  const sendGoogleConversion = (label) => {
    if (!global.googleAdsId || !label || !window.gtag) return;
    window.gtag('event', 'conversion', { send_to: `${global.googleAdsId}/${label}` });
  };
  const sendMeta = (eventName) => {
    if (window.fbq) window.fbq('trackCustom', eventName);
  };
  const track = (eventName, label) => {
    if (window.gtag) window.gtag('event', eventName, { event_category: 'engagement' });
    sendGoogleConversion(label);
    sendMeta(eventName);
  };

  document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
    link.addEventListener('click', () => track('call_click', global.googleCallConversionLabel));
  });
  document.querySelectorAll('a[href*="zomato"], a[href*="swiggy"]').forEach((link) => {
    link.addEventListener('click', () => track('order_click', global.googleOrderConversionLabel));
  });
  document.querySelectorAll('a[href*="google.com/maps"], a[href*="maps.app.goo.gl"], a[href*="contact.html"]').forEach((link) => {
    link.addEventListener('click', () => track('directions_click', global.googleDirectionsConversionLabel));
  });
  document.querySelectorAll('a[href*="menu.html"]').forEach((link) => {
    link.addEventListener('click', () => track('menu_click'));
  });
  document.querySelectorAll('a[href*="blogs.html"], a[href*="blog-post.html"]').forEach((link) => {
    link.addEventListener('click', () => track('blog_click'));
  });
}

function upsertJsonLd(id, data) {
  let script = document.getElementById(id);
  if (!script) {
    script = document.createElement('script');
    script.id = id;
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(data);
}

function applyStructuredData(content = {}) {
  const global = content.global || {};
  const contact = content.contact || {};
  const menu = content.menu || {};
  const blogs = content.blogs || {};
  const siteUrl = (global.siteUrl || location.origin).replace(/\/$/, '');
  const sameAs = [global.instagramUrl, global.googleBusinessUrl].filter(Boolean);

  upsertJsonLd('restaurant-schema-dynamic', {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: 'Red Lantern Restaurant',
    url: `${siteUrl}/`,
    image: absoluteUrl(global.ogImage || 'images/Redlanternlogo.png', siteUrl),
    telephone: contact.phone || '+91 99228 53605',
    email: contact.email,
    servesCuisine: ['Chinese', 'Goan', 'Seafood'],
    priceRange: '₹₹',
    address: {
      '@type': 'PostalAddress',
      streetAddress: contact.address || 'Near Chinchmorod Vanelim, Colva, Goa, 403708',
      addressLocality: 'Colva',
      addressRegion: 'Goa',
      addressCountry: 'IN'
    },
    openingHours: contact.hours,
    hasMenu: `${siteUrl}/menu.html`,
    acceptsReservations: true,
    keywords: global.seoKeywords,
    sameAs,
    potentialAction: [
      global.zomatoUrl ? {
        '@type': 'OrderAction',
        target: global.zomatoUrl,
        name: 'Order on Zomato'
      } : null,
      global.swiggyUrl ? {
        '@type': 'OrderAction',
        target: global.swiggyUrl,
        name: 'Order on Swiggy'
      } : null
    ].filter(Boolean)
  });

  if (currentPage() === 'menu.html' && Array.isArray(menu.dishes)) {
    upsertJsonLd('menu-schema-dynamic', {
      '@context': 'https://schema.org',
      '@type': 'Menu',
      name: menu.pageTitle || 'Red Lantern Menu',
      hasMenuSection: Object.entries(menu.dishes.reduce((groups, dish) => {
        const category = dish.category || 'Signature Dishes';
        groups[category] = groups[category] || [];
        groups[category].push(dish);
        return groups;
      }, {})).map(([category, dishes]) => ({
        '@type': 'MenuSection',
        name: category,
        hasMenuItem: dishes.map((dish) => ({
          '@type': 'MenuItem',
          name: dish.name,
          description: dish.description,
          image: dish.image ? absoluteUrl(dish.image, siteUrl) : undefined,
          offers: dish.price ? {
            '@type': 'Offer',
            price: dish.price,
            priceCurrency: 'INR'
          } : undefined
        }))
      }))
    });
  }

  if (currentPage() === 'blog-post.html') {
    const slug = getSlug();
    const posts = publishedPosts(blogs.posts || []);
    const post = slug ? posts.find((item) => item.slug === slug) : posts[0];
    if (post) {
      upsertJsonLd('article-schema-dynamic', {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.seoDescription || post.excerpt,
        image: post.image ? absoluteUrl(post.image, siteUrl) : absoluteUrl(global.ogImage || 'images/Redlanternlogo.png', siteUrl),
        author: {
          '@type': 'Organization',
          name: 'Red Lantern Restaurant'
        },
        publisher: {
          '@type': 'Organization',
          name: 'Red Lantern Restaurant',
          logo: {
            '@type': 'ImageObject',
            url: absoluteUrl('images/Redlanternlogo.png', siteUrl)
          }
        },
        mainEntityOfPage: `${siteUrl}/blog-post.html?slug=${post.slug}`
      });
    }
  }
}

function applyHome(home = {}, blogs = {}) {
  if (currentPage() !== 'index.html') return;
  const hero = document.querySelector('.hero');
  if (hero && home.heroImage) hero.style.backgroundImage = `linear-gradient(90deg, rgba(18, 11, 8, 0.72), rgba(18, 11, 8, 0.32)), url("${home.heroImage}")`;
  setHtml(document.querySelector('.hero h1'), escapeHtml(home.heroTitle).replace(/\s+of\s+/i, '<br />of '));
  setText(document.querySelector('.hero p'), home.heroSubtitle);
  setText(document.querySelector('.welcome-copy h2'), home.welcomeTitle);
  setHtml(document.querySelector('.welcome-copy p'), home.welcomeText ? escapeHtml(home.welcomeText) : '');
  if (home.welcomeImage) document.querySelector('.welcome-media')?.style.setProperty('background-image', `url("${home.welcomeImage}")`);

  const featureCards = document.querySelectorAll('.why-us .card');
  setText(featureCards[0]?.querySelector('h3'), home.featureOneTitle);
  setText(featureCards[0]?.querySelector('p'), home.featureOneText);
  setText(featureCards[1]?.querySelector('h3'), home.featureTwoTitle);
  setText(featureCards[1]?.querySelector('p'), home.featureTwoText);
  setText(featureCards[2]?.querySelector('h3'), home.featureThreeTitle);
  setText(featureCards[2]?.querySelector('p'), home.featureThreeText);

  const reviewGrid = document.querySelector('.testimonials .card-grid');
  if (reviewGrid && Array.isArray(home.reviews) && home.reviews.length) {
    let reviewOffset = Math.floor(Date.now() / 60000) % home.reviews.length;
    const renderReviews = () => {
      const ordered = [...home.reviews.slice(reviewOffset), ...home.reviews.slice(0, reviewOffset)];
      reviewGrid.innerHTML = ordered.slice(0, 3).map((review) => `
        <article class="review-card">
          <div class="stars">${escapeHtml(review.stars || '★★★★★')}</div>
          <p>${escapeHtml(review.text)}</p>
          <span class="reviewer">- ${escapeHtml(review.name)}</span>
        </article>
      `).join('');
      reviewOffset = (reviewOffset + 1) % home.reviews.length;
    };
    renderReviews();
    if (reviewRotationTimer) clearInterval(reviewRotationTimer);
    if (home.reviews.length > 1) reviewRotationTimer = setInterval(renderReviews, 9000);
  }

  setText(document.querySelector('.latest-blogs h2'), home.blogSectionTitle);
  setText(document.querySelector('.latest-blogs > p'), home.blogSectionSubtitle);
  renderBlogCards(document.querySelector('.latest-blogs .blog-grid'), publishedPosts(blogs.posts || []).slice(0, 3));
}

function renderMenu(menu = {}, global = {}) {
  if (currentPage() !== 'menu.html') return;
  setPageSeo({
    title: `${menu.pageTitle || 'Menu'} | Red Lantern Restaurant Colva`,
    description: menu.pageSubtitle || 'Explore Red Lantern Restaurant menu in Colva, Goa: Chinese specialties, Goan seafood, fried rice, tandoori dishes, and dinner specials.',
    image: (menu.dishes || []).find((dish) => dish.image)?.image
  }, global);
  setText(document.querySelector('.menu-hero h1'), menu.pageTitle);
  setText(document.querySelector('.menu-hero p'), menu.pageSubtitle);
  const container = document.querySelector('.menu-page');
  const firstBlock = document.querySelector('.menu-category-block');
  if (!container || !firstBlock || !Array.isArray(menu.dishes) || !menu.dishes.length) return;

  document.querySelectorAll('.menu-category-block').forEach((block) => block.remove());
  const grouped = menu.dishes.reduce((groups, dish) => {
    const category = dish.category || 'Signature Dishes';
    groups[category] = groups[category] || [];
    groups[category].push(dish);
    return groups;
  }, {});

  const markup = Object.entries(grouped).map(([category, dishes], index) => `
    <section class="menu-category-block ${index === 0 ? 'menu-category-block-first' : ''}">
      <div class="menu-category-head">
        <span class="menu-category-icon menu-category-icon-red">✦</span>
        <h2>${escapeHtml(category)}</h2>
      </div>
      <div class="menu-item-grid">
        ${dishes.map((dish) => `
          <article class="menu-item-card ${dish.image ? 'has-image' : ''}">
            ${dish.image ? `<div class="menu-item-image"><img src="${escapeHtml(dish.image)}" alt="${escapeHtml(`${dish.name} at Red Lantern Restaurant in Colva`)}" loading="lazy">${dish.badge ? `<span class="dish-badge">${escapeHtml(dish.badge)}</span>` : ''}</div>` : ''}
            <div class="menu-item-copy">
              <h3>${escapeHtml(dish.name)}</h3>
              <p>${escapeHtml(dish.description)}</p>
              ${dish.price ? `<strong>${escapeHtml(dish.price)}</strong>` : ''}
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `).join('');

  document.querySelector('.menu-order-strip')?.insertAdjacentHTML('afterend', markup);
  setText(document.querySelector('.menu-note-strip p'), menu.note);
}

function renderBlogCards(container, posts = []) {
  if (!container || !posts.length) return;
  container.innerHTML = posts.map((post, index) => `
    <article class="blog-card">
      <a href="blog-post.html?slug=${encodeURIComponent(post.slug)}">
        ${post.image ? `<div class="blog-thumb" style="background-image:url('${post.image}')"></div>` : `<div class="blog-thumb ${index === 1 ? 'blog-thumb-alt' : index === 2 ? 'blog-thumb-third' : ''}"></div>`}
        <div class="blog-body">
          <h2>${escapeHtml(post.title)}</h2>
          <p>${escapeHtml(post.excerpt)}</p>
          <span class="blog-meta">${escapeHtml(post.meta)}</span>
        </div>
      </a>
    </article>
  `).join('');
}

function renderBlogsPage(blogs = {}, global = {}) {
  if (currentPage() !== 'blogs.html') return;
  setPageSeo({
    title: `${blogs.pageTitle || 'Red Lantern Journal'} | Colva Food Guides`,
    description: blogs.pageSubtitle || 'Read Red Lantern Restaurant stories, menu guides, Chinese food recommendations, and local dining tips for Colva and South Goa.',
    image: publishedPosts(blogs.posts || []).find((post) => post.image)?.image
  }, global);
  setText(document.querySelector('.blog-hero h1'), blogs.pageTitle);
  setText(document.querySelector('.blog-hero p'), blogs.pageSubtitle);
  renderBlogCards(document.querySelector('.blog-page > .blog-grid'), publishedPosts(blogs.posts || []));
}

function renderBlogPost(blogs = {}, global = {}) {
  if (currentPage() !== 'blog-post.html') return;
  const slug = getSlug();
  const posts = publishedPosts(blogs.posts || []);
  const post = slug ? posts.find((item) => item.slug === slug) : posts[0];
  if (!post) {
    setPageSeo({
      title: 'Article Not Available | Red Lantern Journal',
      description: 'This article is not available yet.',
      image: global.ogImage,
      type: 'article'
    }, global);
    upsertMeta('meta[name="robots"]', { name: 'robots', content: 'noindex,follow' });
    setText(document.querySelector('.blog-post-header h1'), 'Article not available yet');
    setText(document.querySelector('.blog-post-header .blog-meta'), '');
    const hero = document.querySelector('.blog-post-hero');
    if (hero) hero.style.display = 'none';
    setHtml(document.querySelector('.blog-post-content'), '<p>This article is scheduled and will appear here when it is published.</p><p><a href="blogs.html">Back to all articles</a></p>');
    return;
  }

  setPageSeo({
    title: post.seoTitle || `${post.title} | Red Lantern Journal`,
    description: post.seoDescription || post.excerpt || '',
    image: post.image,
    type: 'article'
  }, global);
  setText(document.querySelector('.blog-post-header h1'), post.title);
  setText(document.querySelector('.blog-post-header .blog-meta'), post.meta);
  if (post.image) document.querySelector('.blog-post-hero')?.style.setProperty('background-image', `url("${post.image}")`);
  setHtml(document.querySelector('.blog-post-content'), articleHtml(post.content || post.excerpt));
}

function renderAbout(about = {}, global = {}) {
  if (currentPage() !== 'about.html') return;
  setPageSeo({
    title: `${about.heroTitle || 'About Red Lantern'} | Restaurant in Colva, Goa`,
    description: about.heroSubtitle || 'Learn about Red Lantern Restaurant in Colva, Goa, our story, authentic Chinese and Goan flavors, and open-air dining experience.',
    image: about.heroImage || about.storyImage
  }, global);
  setText(document.querySelector('.about-hero h1'), about.heroTitle);
  setText(document.querySelector('.about-hero p'), about.heroSubtitle);
  setText(document.querySelector('.about-page-main .welcome-copy h2'), about.storyTitle);
  const story = document.querySelector('.about-page-main .welcome-copy');
  if (story && about.storyText) setHtml(story.querySelector('p'), escapeHtml(about.storyText));
  if (about.storyImage) document.querySelector('.about-media-1')?.style.setProperty('background-image', `url("${about.storyImage}")`);
}

updateActiveNav();

fetch('/api/content')
  .then((response) => response.ok ? response.json() : {})
  .then((content) => {
    applyContact(content.contact);
    applyGlobal(content.global);
    applyHome(content.home, content.blogs);
    renderMenu(content.menu, content.global);
    renderBlogsPage(content.blogs, content.global);
    renderBlogPost(content.blogs, content.global);
    renderAbout(content.about, content.global);
    applyStructuredData(content);
  })
  .catch(() => {})
  .finally(() => {
    document.documentElement.classList.remove('cms-loading');
  });

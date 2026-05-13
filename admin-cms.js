const setField = (name, value) => {
  const field = document.querySelector(`[name="${name}"]`);
  if (field && value !== undefined) field.value = value;
};

const setStatus = (form, message, isError = false) => {
  let status = form.querySelector('.save-status');
  if (!status) {
    status = document.createElement('p');
    status.className = 'save-status';
    status.style.fontWeight = '700';
    status.style.marginTop = '12px';
    form.appendChild(status);
  }
  status.textContent = message;
  status.style.color = isError ? '#b91c1c' : '#166534';
};

function fillContact(contact = {}) {
  setField('address', contact.address);
  setField('hours', contact.hours);
  setField('phone', contact.phone);
  setField('email', contact.email);
  setField('mapEmbedUrl', contact.mapEmbedUrl);
}

function fillGlobal(global = {}) {
  setField('footerDescription', global.footerDescription);
  setField('zomatoUrl', global.zomatoUrl);
  setField('swiggyUrl', global.swiggyUrl);
  setField('siteUrl', global.siteUrl);
  setField('seoTitle', global.seoTitle);
  setField('seoDescription', global.seoDescription);
  setField('seoKeywords', global.seoKeywords);
  setField('ogImage', global.ogImage);
  setField('instagramUrl', global.instagramUrl);
  setField('googleBusinessUrl', global.googleBusinessUrl);
  setField('gaMeasurementId', global.gaMeasurementId);
  setField('googleAdsId', global.googleAdsId);
  setField('googleCallConversionLabel', global.googleCallConversionLabel);
  setField('googleOrderConversionLabel', global.googleOrderConversionLabel);
  setField('googleDirectionsConversionLabel', global.googleDirectionsConversionLabel);
  setField('metaPixelId', global.metaPixelId);
  setField('targetLocations', global.targetLocations);
  setField('targetCuisines', global.targetCuisines);
  setField('competitorNames', global.competitorNames);
  setField('competitorResearchNotes', global.competitorResearchNotes);
}

function fillHome(home = {}) {
  [
    'heroTitle',
    'heroSubtitle',
    'welcomeTitle',
    'welcomeText',
    'featureOneTitle',
    'featureOneText',
    'featureTwoTitle',
    'featureTwoText',
    'featureThreeTitle',
    'featureThreeText',
    'blogSectionTitle',
    'blogSectionSubtitle'
  ].forEach((name) => setField(name, home[name]));
}

function fillMenu(menu = {}) {
  setField('menuPageTitle', menu.pageTitle);
  setField('menuPageSubtitle', menu.pageSubtitle);
  setField('menuNote', menu.note);
}

function fillBlogs(blogs = {}) {
  setField('blogPageTitle', blogs.pageTitle);
  setField('blogPageSubtitle', blogs.pageSubtitle);
}

function fillAbout(about = {}) {
  setField('aboutHeroTitle', about.heroTitle);
  setField('aboutHeroSubtitle', about.heroSubtitle);
  setField('aboutStoryTitle', about.storyTitle);
  setField('aboutStoryText', about.storyText);
}

const renderGrowthItems = (id, items) => {
  const container = document.getElementById(id);
  if (!container) return;
  container.innerHTML = items.map((item) => `
    <div class="growth-item">
      <strong>${item.title}</strong>
      <span>${item.detail}</span>
      ${item.tag ? `<div class="growth-tag">${item.tag}</div>` : ''}
    </div>
  `).join('');
};

const currentSeason = () => {
  const month = new Date().getMonth() + 1;
  if ([11, 12, 1, 2].includes(month)) return 'peak tourist season';
  if ([6, 7, 8, 9].includes(month)) return 'monsoon season';
  if ([3, 4, 5].includes(month)) return 'summer travel season';
  return 'shoulder season';
};

function buildGrowthDashboard(content = {}) {
  const global = content.global || {};
  const contact = content.contact || {};
  const menu = content.menu || {};
  const blogs = content.blogs || {};
  const posts = blogs.posts || [];
  const dishes = menu.dishes || [];
  const season = currentSeason();
  const hasAds = global.gaMeasurementId || global.googleAdsId || global.metaPixelId;
  const hasLocalSeo = contact.address && contact.phone && contact.mapEmbedUrl && global.googleBusinessUrl;
  const hasBlogEngine = posts.length >= 3;
  const hasMenuDepth = dishes.length >= 8;
  const hasOrdering = global.zomatoUrl && global.swiggyUrl;
  const hasSeoBasics = global.siteUrl && global.seoTitle && global.seoDescription && global.seoKeywords;
  const targetLocations = String(global.targetLocations || 'Colva, South Goa').split(',').map((item) => item.trim()).filter(Boolean);
  const targetCuisines = String(global.targetCuisines || 'Chinese food, Goan seafood').split(',').map((item) => item.trim()).filter(Boolean);
  const competitors = String(global.competitorNames || '').split(',').map((item) => item.trim()).filter(Boolean);
  const score = [hasAds, hasLocalSeo, hasBlogEngine, hasMenuDepth, hasOrdering, hasSeoBasics]
    .filter(Boolean).length;

  const scoreText = document.getElementById('growth-score');
  if (scoreText) scoreText.textContent = `${Math.round((score / 6) * 100)}% ready`;

  const actions = [
    !hasLocalSeo && {
      title: 'Finish local SEO fields (Contact & Global Settings)',
      detail: 'Go to the "Contact Page" tab and add your exact Address, Phone, and Google Map Embed URL. Then go to "Footer & Settings" > "SEO Defaults" and add your Google Business Profile URL. These are critical for ranking on Google Maps in Colva.',
      tag: 'High impact'
    },
    !hasMenuDepth && {
      title: 'Expand the dynamic menu (Menu Page)',
      detail: 'Go to the "Menu Page" tab and add at least 8-12 signature dishes. Be sure to use categories (e.g., "Goan Seafood") and write descriptions with keywords to help Google understand what you serve.',
      tag: 'SEO content'
    },
    !hasBlogEngine && {
      title: 'Publish more local food blogs (Blogs Page)',
      detail: 'Go to the "Blogs Page" tab and publish at least 3-6 posts. Use the blog ideas below. For example, write about "Best Chinese Food in Colva" using H2 tags for keywords and include original photos.',
      tag: 'Visibility'
    },
    !hasAds && {
      title: 'Add ad tracking before spending (Footer & Settings)',
      detail: 'Go to the "Footer & Settings" tab > "Ads & Tracking" and paste your GA4, Google Ads, and Meta Pixel IDs. Do this before running any ads so you can track calls, menu views, and orders.',
      tag: 'Before ads'
    },
    !hasOrdering && {
      title: 'Add real Zomato and Swiggy links (Footer & Settings)',
      detail: 'Go to "Footer & Settings" > "Footer Content" and add your exact Zomato and Swiggy URLs. This turns website visitors into paying customers immediately.',
      tag: 'Conversion'
    },
    {
      title: 'Compare your offer against nearby competitors',
      detail: competitors.length
        ? `You listed: ${competitors.slice(0, 4).join(', ')}. Go to the "Menu" and "About" pages to ensure your photos, prices, and story look more appealing than theirs.`
        : 'Go to "Footer & Settings" > "Market Research Inputs". Add competitor names so we can suggest targeted content to beat them.',
      tag: 'Competition'
    },
    {
      title: `Plan content for ${season}`,
      detail: season === 'monsoon season'
        ? 'Update your "Home Page" hero subtitle and "Blogs Page" to push cozy indoor dining, hot soups, and delivery options.'
        : 'Update your "Home Page" hero and "Blogs" to push tourist-friendly searches, seafood, and late-night dinners near Colva Beach.',
      tag: 'Seasonal'
    }
  ].filter(Boolean);

  if (actions.length <= 2 && score === 6) { // Only Competitor/Seasonal are left
    actions.unshift({
      title: '✅ 100% SEO Foundation Ready! (Green Signal)',
      detail: 'Amazing work! Your website has strong foundational SEO, rich menus, full tracking, and contact details. Now focus on publishing more blogs and running targeted ads based on the ideas below.',
      tag: 'All Good!'
    });
  }

  const dishNames = dishes.map((dish) => dish.name).filter(Boolean);
  const primaryLocation = targetLocations[0] || 'Colva';
  const secondaryLocation = targetLocations[1] || 'South Goa';
  const primaryCuisine = targetCuisines[0] || 'Chinese food';
  const secondaryCuisine = targetCuisines[1] || 'Goan seafood';
  const blogIdeas = [
    {
      title: `Best ${primaryCuisine} in ${primaryLocation}: What to Order at Red Lantern`,
      detail: `Go to "Blogs Page" tab. Feature ${dishNames.slice(0, 3).join(', ') || 'your top dishes'} with photos, prices, reviews, and why guests love them. Link to your Menu page.`,
      tag: 'Blog'
    },
    {
      title: `${secondaryCuisine} Restaurant Near ${primaryLocation}: A Local Guide`,
      detail: `Go to "Blogs Page" tab. Target tourists searching around ${primaryLocation}. Include distance, ambience, opening hours, fish/prawn dishes, and embed your Google Map.`,
      tag: 'Local SEO'
    },
    {
      title: `Family Restaurant in ${secondaryLocation}: Why Red Lantern Works for Groups`,
      detail: 'Go to "Blogs Page" tab. Write about seating, budget-friendly dishes, kids/family choices, order online options, and dinner timing. Link to your Contact page.',
      tag: 'Commercial'
    },
    {
      title: `${secondaryLocation} Food Guide: ${targetCuisines.slice(0, 3).join(', ') || 'Chinese, Goan seafood, and comfort food'}`,
      detail: 'Go to "Blogs Page" tab. Create a broad guide that can rank for tourists planning where to eat in Goa before they arrive.',
      tag: 'Tourist search'
    },
    {
      title: `${primaryLocation} Restaurant Comparison: What Makes Red Lantern Different`,
      detail: competitors.length
        ? `Go to "Blogs Page" tab. Compare your strengths against ${competitors.slice(0, 3).join(', ')} without attacking them: cuisine variety, ambience, prices, order links, photos, and location.`
        : 'Go to "Footer & Settings" > "Market Research Inputs" to add competitors. Then write a blog comparing your restaurant to them.',
      tag: 'Competitive'
    },
    {
      title: `${season.charAt(0).toUpperCase() + season.slice(1)} Food Picks in Goa`,
      detail: 'Go to "Blogs Page" tab. Tie current season to practical menu recommendations, photos, and calls to action for directions and orders.',
      tag: 'Seasonal'
    }
  ];

  const adIdeas = [
    {
      title: `Google Search Campaign: “restaurants near ${primaryLocation}”`,
      detail: 'Create a Google Ad sending traffic to your Home or Contact page. Make sure "Footer & Settings" has tracking IDs and conversion labels set up first.',
      tag: 'High intent'
    },
    {
      title: `Google Search Campaign: “best ${primaryCuisine} in ${primaryLocation}”`,
      detail: `Create a Google Ad sending traffic directly to your Menu page. Focus keywords on ${primaryCuisine}.`,
      tag: 'Keyword'
    },
    {
      title: 'Instagram Campaign: food photos + directions',
      detail: 'Create a Meta/Instagram Ad using your best dish photos. Set the Call-To-Action to "Get Directions" or "Order Now". Ensure Meta Pixel ID is saved in "Footer & Settings".',
      tag: 'Awareness'
    },
    {
      title: 'Tourist campaign before arrival',
      detail: 'Target Google/Meta ads to people interested in Goa travel, Colva, South Goa hotels, beaches, seafood, and family restaurants.',
      tag: 'Future'
    },
    {
      title: 'Competitor defense campaign',
      detail: competitors.length
        ? `Create Google Ads targeting people searching for ${competitors.slice(0, 3).join(', ')}. Highlight your better prices or ambience.`
        : 'Go to "Footer & Settings" and add competitors first to get specific ad targets here.',
      tag: 'Competitive'
    }
  ];

  const checklist = [
    ['Google Business Profile linked', Boolean(global.googleBusinessUrl), 'Go to "Footer & Settings" > "SEO Defaults" > Add "Google Business Profile URL"'],
    ['GA4 / Google Ads / Meta Pixel added', Boolean(hasAds), 'Go to "Footer & Settings" > "Ads & Tracking" > Add at least one Tracking ID'],
    ['Real Zomato and Swiggy URLs added', Boolean(hasOrdering), 'Go to "Footer & Settings" > "Footer Content" > Add both Order Links'],
    ['At least 8 menu items added', Boolean(hasMenuDepth), 'Go to "Menu Page" > Add 8+ dishes with photos and descriptions'],
    ['At least 3 blogs published', Boolean(hasBlogEngine), 'Go to "Blogs Page" > Publish 3+ SEO-optimized articles'],
    ['SEO title, description, keywords, and site URL saved', Boolean(hasSeoBasics), 'Go to "Footer & Settings" > "SEO Defaults" > Fill all 4 SEO fields'],
    ['Map embed, address, phone, and hours saved', Boolean(contact.mapEmbedUrl && contact.address && contact.phone && contact.hours), 'Go to "Contact Page" > Fill out Contact Details and Google Map Embed'],
    ['Competitors, target locations, and target searches saved', Boolean(competitors.length && targetLocations.length && targetCuisines.length), 'Go to "Footer & Settings" > "Market Research Inputs" > Fill all 3 fields']
  ].map(([title, done, instruction]) => ({
    title: `${done ? '✅ Done' : '❌ Needed'}: ${title}`,
    detail: done ? 'This part is ready.' : `ACTION: ${instruction}`,
    tag: done ? 'Ready' : 'Missing'
  }));

  renderGrowthItems('growth-actions', actions);
  renderGrowthItems('growth-blog-ideas', blogIdeas);
  renderGrowthItems('growth-ad-ideas', adIdeas);
  renderGrowthItems('growth-checklist', checklist);
}

fetch('/api/content')
  .then((response) => response.ok ? response.json() : {})
  .then((content) => {
    fillHome(content.home);
    fillMenu(content.menu);
    fillBlogs(content.blogs);
    fillAbout(content.about);
    fillContact(content.contact);
    fillGlobal(content.global);
    buildGrowthDashboard(content);
  })
  .catch(() => {});

document.querySelectorAll('form[action^="/api/update-"]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus(form, 'Saving...');

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form)
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      setStatus(form, 'Saved. Refresh the public page to see the update.');
    } catch (error) {
      setStatus(form, error.message || 'Save failed.', true);
    }
  });
});

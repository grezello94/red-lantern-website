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

function reportClientDiagnostic(payload) {
  try {
    const body = JSON.stringify({
      path: window.location.pathname,
      href: window.location.href,
      ...payload
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
  } catch {
    // Diagnostics must never interrupt the admin UI.
  }
}

window.addEventListener('error', (event) => {
  reportClientDiagnostic({
    category: 'frontend',
    level: 'error',
    message: event.message || 'Admin browser script error.',
    source: event.filename || 'admin browser',
    line: event.lineno || '',
    column: event.colno || '',
    stack: event.error?.stack || ''
  });
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientDiagnostic({
    category: 'frontend',
    level: 'error',
    message: event.reason?.message || 'Admin browser promise failed.',
    source: 'admin browser promise',
    stack: event.reason?.stack || String(event.reason || '')
  });
});

const cleanDescriptionText = (value) => {
  const template = document.createElement('template');
  template.innerHTML = String(value || '').replace(/<br\s*\/?>/gi, ' ');
  return (template.content.textContent || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
};

const trimDescription = (value, maxLength) => {
  const text = cleanDescriptionText(value);
  if (text.length <= maxLength) return text;

  const clipped = text.slice(0, maxLength + 1);
  const boundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf(', '),
    clipped.lastIndexOf(' ')
  );
  const trimmed = clipped.slice(0, boundary > 80 ? boundary : maxLength).replace(/[,\s.]+$/, '');
  return `${trimmed}.`;
};

const firstUsefulSentence = (value) => {
  const text = cleanDescriptionText(value);
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  return cleanDescriptionText(sentences.find((sentence) => cleanDescriptionText(sentence).length >= 55) || sentences[0]);
};

const includesLocalContext = (value) => /red lantern|colva|south goa|goa/i.test(value);

function generatedBlogDescriptions(title, content) {
  const cleanTitle = cleanDescriptionText(title);
  const lead = firstUsefulSentence(content) || cleanTitle;
  const localPhrase = 'Red Lantern Restaurant in Colva, South Goa';

  const excerptSeed = cleanTitle && lead && !lead.toLowerCase().includes(cleanTitle.toLowerCase())
    ? `${cleanTitle}: ${lead}`
    : lead || cleanTitle;
  const excerpt = trimDescription(excerptSeed, 165);

  const leadHasTitle = cleanTitle && lead.toLowerCase().includes(cleanTitle.toLowerCase());
  const seoSeed = lead && !leadHasTitle
    ? `${lead} Visit ${localPhrase} for Chinese and Goan food in Colva.`
    : `${cleanTitle || lead} at ${localPhrase}.`;
  const seoDescription = trimDescription(
    includesLocalContext(seoSeed) ? seoSeed : `${seoSeed} Discover Chinese and Goan food in Colva.`,
    155
  );

  return { excerpt, seoDescription };
}

function updateBlogGeneratedDescriptions(entry, force = false) {
  if (!entry) return;
  const title = entry.querySelector('[name="blogTitle[]"]')?.value || '';
  const content = entry.querySelector('[name="blogContent[]"]')?.value || '';
  const excerptField = entry.querySelector('[name="blogExcerpt[]"]');
  const seoField = entry.querySelector('[name="blogSeoDescription[]"]');
  const generated = generatedBlogDescriptions(title, content);

  if (excerptField && generated.excerpt) {
    const canUpdate = force || !excerptField.value.trim() || excerptField.dataset.generated === 'true';
    if (canUpdate) {
      excerptField.value = generated.excerpt;
      excerptField.dataset.generated = 'true';
    }
  }

  if (seoField && generated.seoDescription) {
    const canUpdate = force || !seoField.value.trim() || seoField.dataset.generated === 'true';
    if (canUpdate) {
      seoField.value = generated.seoDescription;
      seoField.dataset.generated = 'true';
    }
  }
}

function setupBlogDescriptionGenerator() {
  const container = document.getElementById('blogs-container');
  if (!container) return;

  container.querySelectorAll('.blog-entry').forEach((entry) => updateBlogGeneratedDescriptions(entry));
  if (container.dataset.descriptionGeneratorReady === 'true') return;
  container.dataset.descriptionGeneratorReady = 'true';

  container.addEventListener('input', (event) => {
    if (event.target.matches('[name="blogExcerpt[]"], [name="blogSeoDescription[]"]')) {
      event.target.dataset.generated = 'false';
      return;
    }

    if (event.target.matches('[name="blogTitle[]"], [name="blogContent[]"]')) {
      updateBlogGeneratedDescriptions(event.target.closest('.blog-entry'));
    }
  });

  container.addEventListener('click', (event) => {
    const button = event.target.closest('.generate-blog-description-btn');
    if (!button) return;
    updateBlogGeneratedDescriptions(button.closest('.blog-entry'), true);
  });
}

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
    'currentHeroImage',
    'welcomeTitle',
    'welcomeText',
    'currentWelcomeImage',
    'featureOneTitle',
    'featureOneText',
    'featureTwoTitle',
    'featureTwoText',
    'featureThreeTitle',
    'featureThreeText',
    'blogSectionTitle',
    'blogSectionSubtitle'
  ].forEach((name) => setField(name, home[name]));

  const heroPreview = document.querySelector('input[name="heroImage"]')?.closest('.form-group')?.querySelector('.image-preview');
  if (heroPreview && home.heroImage) heroPreview.src = home.heroImage;

  const welcomePreview = document.querySelector('input[name="welcomeImage"]')?.closest('.form-group')?.querySelector('.image-preview');
  if (welcomePreview && home.welcomeImage) welcomePreview.src = home.welcomeImage;

  renderHomeReviewEntries(home.reviews);
}

function reviewEntryMarkup(review = {}, index = 0) {
  return `
    <div class="review-entry">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f3f4f6; margin: 10px 0 16px; padding-bottom: 8px;">
        <h3 style="font-size: 16px; color: #d62828; margin: 0;">Review ${index + 1}</h3>
        <button type="button" class="remove-review-btn" style="color: #ef4444; background: none; border: none; cursor: pointer; font-size: 14px; font-weight: 700;">Remove</button>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Reviewer Name</label>
          <input type="text" name="reviewName[]" value="${escapeHtml(review.name || '')}" placeholder="e.g. John Doe">
        </div>
        <div class="form-group">
          <label>Star Rating</label>
          <input type="text" name="reviewStars[]" value="${escapeHtml(review.stars || '★★★★★')}">
        </div>
      </div>
      <div class="form-grid full" style="margin-bottom: 30px;">
        <div class="form-group">
          <label>Review Text</label>
          <textarea name="reviewText[]" rows="3" placeholder="Paste the glowing Google review here...">${escapeHtml(review.text || '')}</textarea>
        </div>
      </div>
    </div>
  `;
}

function renderHomeReviewEntries(reviews = []) {
  const reviewsContainer = document.getElementById('reviews-container');
  if (!reviewsContainer || !Array.isArray(reviews) || !reviews.length) return;
  reviewsContainer.innerHTML = reviews.map((review, index) => reviewEntryMarkup(review, index)).join('');
}

function dishEntryMarkup(dish = {}, index = 0) {
  return `
    <div class="dish-entry">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f3f4f6; margin: 10px 0 16px; padding-bottom: 8px;">
        <h3 style="font-size: 16px; color: #d62828; margin: 0;">Dish Item ${index + 1}</h3>
        <button type="button" class="remove-dish-btn" style="color: #ef4444; background: none; border: none; cursor: pointer; font-size: 14px; font-weight: 700;">Remove</button>
      </div>
      <input type="hidden" name="currentDishImage[]" value="${escapeHtml(dish.image || '')}">
      <div class="form-grid">
        <div class="form-group">
          <label>Dish Name</label>
          <input type="text" name="dishName[]" value="${escapeHtml(dish.name || '')}" placeholder="e.g. Spring Rolls">
        </div>
        <div class="form-group">
          <label>Price</label>
          <input type="text" name="dishPrice[]" value="${escapeHtml(dish.price || '')}" placeholder="e.g. ₹200">
        </div>
        <div class="form-group">
          <label>Category</label>
          <input type="text" name="dishCategory[]" value="${escapeHtml(dish.category || 'Signature Dishes')}" placeholder="e.g. Chinese Specialties">
        </div>
        <div class="form-group">
          <label>Badge</label>
          <input type="text" name="dishBadge[]" value="${escapeHtml(dish.badge || '')}" placeholder="e.g. Popular">
        </div>
      </div>
      <div class="form-grid full" style="margin-bottom: 30px;">
        <div class="form-group">
          <label>Description</label>
          <textarea name="dishDesc[]" rows="2" placeholder="Describe the dish...">${escapeHtml(dish.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Dish Photo</label>
          <span class="help-text">Upload a high-quality photo of this dish.</span>
          <input type="file" name="dishPhoto_${index}" accept="image/*">
          ${dish.image ? `<img src="${escapeHtml(dish.image)}" class="image-preview" alt="Current dish photo">` : ''}
        </div>
      </div>
    </div>
  `;
}

function blogEntryMarkup(post = {}, index = 0) {
  return `
    <div class="blog-entry">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f3f4f6; margin: 10px 0 16px; padding-bottom: 8px;">
        <h3 style="font-size: 16px; color: #d62828; margin: 0;">Blog Post ${index + 1}</h3>
        <button type="button" class="remove-blog-btn" style="color: #ef4444; background: none; border: none; cursor: pointer; font-size: 14px; font-weight: 700;">Remove</button>
      </div>
      <input type="hidden" name="currentBlogImage[]" value="${escapeHtml(post.image || '')}">
      <input type="hidden" name="currentBlogArticleImage[]" value="${escapeHtml(post.articleImage || '')}">
      <div class="form-grid full">
        <div class="form-group">
          <label>Article Title</label>
          <input type="text" name="blogTitle[]" value="${escapeHtml(post.title || '')}" placeholder="e.g. Top 5 Goan Seafood Dishes">
        </div>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Publish Date & Read Time</label>
          <span class="help-text">Auto-generated from the schedule and article length.</span>
          <input type="text" name="blogMeta[]" value="${escapeHtml(post.meta || '')}" placeholder="Auto-generated on save" readonly>
        </div>
        <div class="form-group">
          <label>Schedule Publish Date & Time</label>
          <span class="help-text">India time. Leave blank to publish immediately.</span>
          <input type="datetime-local" name="blogPublishAt[]" value="${escapeHtml(post.publishAt || '')}">
        </div>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Thumbnail Image</label>
          <span class="help-text">Used for the blog card and top hero image.</span>
          <input type="file" name="blogImage_${index}" accept="image/*">
          ${post.image ? `<img src="${escapeHtml(post.image)}" class="image-preview" alt="Current blog thumbnail">` : ''}
        </div>
        <div class="form-group">
          <label>In-article Photo</label>
          <span class="help-text">Optional. Appears inside the full blog article after the opening paragraph.</span>
          <input type="file" name="blogArticleImage_${index}" accept="image/*">
          ${post.articleImage ? `<img src="${escapeHtml(post.articleImage)}" class="image-preview" alt="Current in-article blog photo">` : ''}
        </div>
      </div>
      <div class="form-grid full">
        <div class="form-group">
          <label>Short Description / Excerpt</label>
          <span class="help-text">Auto-generated from the title and article. Ideal length: under 165 characters.</span>
          <textarea name="blogExcerpt[]" rows="2" placeholder="Write a short summary...">${escapeHtml(post.excerpt || '')}</textarea>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>SEO Title</label>
          <input type="text" name="blogSeoTitle[]" value="${escapeHtml(post.seoTitle || '')}" placeholder="Search result title">
        </div>
        <div class="form-group">
          <label>Meta Description</label>
          <span class="help-text">Shown in Google and page meta tags. Auto-generate it or write your own. Ideal length: 140-155 characters.</span>
          <textarea name="blogSeoDescription[]" rows="2" placeholder="Meta description for Google">${escapeHtml(post.seoDescription || '')}</textarea>
        </div>
      </div>
      <button type="button" class="generate-blog-description-btn" style="background: #111827; color: #fff; border: none; padding: 10px 14px; border-radius: 8px; font-weight: 800; cursor: pointer; margin: -8px 0 24px;">Auto-generate descriptions</button>
      <div class="form-grid full" style="margin-bottom: 30px;">
        <div class="form-group">
          <label>Full Article Content (SEO Optimized)</label>
          <span class="help-text">Write your full post. Use headings (H2) for keywords and add hyperlinks to boost your SEO ranking.</span>
          <div class="rich-text-editor">
            <div class="editor-toolbar">
              <button type="button" title="Bold"><strong>B</strong></button>
              <button type="button" title="Italic"><em>I</em></button>
              <button type="button" title="Heading 2">H2 (Subheading)</button>
              <button type="button" title="Paragraph">¶ (Paragraph)</button>
              <button type="button" title="Insert Link">🔗 Add Link</button>
            </div>
            <textarea name="blogContent[]" rows="8" placeholder="Write your full article here...">${escapeHtml(post.content || '')}</textarea>
          </div>
        </div>
      </div>
    </div>
  `;
}

function fillMenu(menu = {}) {
  setField('menuPageTitle', menu.pageTitle);
  setField('menuPageSubtitle', menu.pageSubtitle);
  setField('menuNote', menu.note);
  const dishesContainer = document.getElementById('dishes-container');
  if (dishesContainer && Array.isArray(menu.dishes) && menu.dishes.length) {
    dishesContainer.innerHTML = menu.dishes.map((dish, index) => dishEntryMarkup(dish, index)).join('');
  }
}

function cleanAirSheetText(value, isCategory = false) {
  let text = String(value || '').replace(/[.…·]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (isCategory) text = text.replace(/^[^a-z0-9(]+/i, '').trim();
  return text;
}

function dietaryFromAirCategory(category) {
  const value = String(category || '').trim();
  if (/\bnon\s*[-/]?\s*veg\b|\bnonveg\b/i.test(value)) return 'nonveg';
  if (/\bveg(?:etarian)?\b/i.test(value)) return 'veg';
  return '';
}

function syncDietaryPickerFromCategory(row) {
  const category = row?.querySelector('[name="airItemCategory[]"]')?.value || '';
  const dietary = dietaryFromAirCategory(category);
  if (!dietary) return false;
  const picker = row.querySelector('.dietary-picker');
  const hidden = picker?.querySelector('[name="airItemDietary[]"]');
  if (!picker || !hidden) return false;
  hidden.value = dietary;
  picker.querySelectorAll('[data-dietary]').forEach((choice) => {
    choice.checked = choice.dataset.dietary === dietary;
  });
  return true;
}

function airItemMarkup(item = {}, index = 0) {
  const dietary = item.dietary || dietaryFromAirCategory(item.category);
  return `
    <tr class="air-item-entry" data-row="${index}">
      <td><label class="sheet-check"><input type="hidden" name="airItemBestSeller[]" value="${item.bestSeller ? 'true' : 'false'}"><input type="checkbox" data-item-flag="bestSeller" ${item.bestSeller ? 'checked' : ''} aria-label="Best Seller"></label></td>
      <td><label class="sheet-check"><input type="hidden" name="airItemMustHave[]" value="${item.mustHave ? 'true' : 'false'}"><input type="checkbox" data-item-flag="mustHave" ${item.mustHave ? 'checked' : ''} aria-label="Must Have"></label></td>
      <td><label class="sheet-check"><input type="hidden" name="airItemGravyStyleAvailable[]" value="${item.gravyStyleAvailable || item.gravyAvailable || item.semiGravyAvailable ? 'true' : 'false'}"><input type="checkbox" data-item-flag="gravyStyleAvailable" ${item.gravyStyleAvailable || item.gravyAvailable || item.semiGravyAvailable ? 'checked' : ''} aria-label="Gravy or Semi-Gravy available"></label></td>
      <td><input type="text" name="airItemName[]" value="${escapeHtml(cleanAirSheetText(item.name))}" placeholder="Item name" required></td>
      <td><input type="text" name="airItemPrice[]" value="${escapeHtml(item.price || '')}" placeholder="₹250"></td>
      <td><input type="text" name="airItemFullPrice[]" value="${escapeHtml(item.fullPrice || '')}" placeholder="₹450"></td>
      <td><input type="text" name="airItemHalfPrice[]" value="${escapeHtml(item.halfPrice || '')}" placeholder="₹280"></td>
      <td><input type="text" name="airItemWithBonePrice[]" value="${escapeHtml(item.withBonePrice || '')}" placeholder="₹450"></td>
      <td><input type="text" name="airItemBonelessPrice[]" value="${escapeHtml(item.bonelessPrice || '')}" placeholder="₹500"></td>
      <td><input type="text" name="airItemCategory[]" list="air-category-options" value="${escapeHtml(cleanAirSheetText(item.category || 'Menu', true))}" placeholder="Choose or type a category" required></td>
      <td><select name="airItemType[]"><option value="food" ${item.type !== 'beverage' ? 'selected' : ''}>Food</option><option value="beverage" ${item.type === 'beverage' ? 'selected' : ''}>Beverage</option></select></td>
      <td><div class="dietary-picker"><input type="hidden" name="airItemDietary[]" value="${dietary}"><label class="dietary-choice veg" title="Veg"><input type="checkbox" data-dietary="veg" ${dietary === 'veg' ? 'checked' : ''}><span class="dietary-mark"></span></label><label class="dietary-choice nonveg" title="Non-Veg"><input type="checkbox" data-dietary="nonveg" ${dietary === 'nonveg' ? 'checked' : ''}><span class="dietary-mark"></span></label></div></td>
      <td><input type="text" name="airItemDescription[]" value="${escapeHtml(item.description || '')}" placeholder="Optional description"></td>
      <td><button type="button" class="remove-air-item" aria-label="Remove row">×</button></td>
    </tr>`;
}

function airBarItemMarkup(item = {}, index = 0) {
  return `
    <tr class="air-bar-item-entry" data-row="${index}">
      <td><input type="text" name="airBarItemName[]" value="${escapeHtml(cleanAirSheetText(item.name))}" placeholder="Item name" required></td>
      <td><input type="text" name="airBarItemPrice[]" value="${escapeHtml(item.price || '')}" placeholder="₹250"></td>
      <td><input type="text" name="airBarItem30mlPrice[]" value="${escapeHtml(item.price30ml || '')}" placeholder="₹180"></td>
      <td><input type="text" name="airBarItem60mlPrice[]" value="${escapeHtml(item.price60ml || '')}" placeholder="₹320"></td>
      <td><input type="text" name="airBarItem90mlPrice[]" value="${escapeHtml(item.price90ml || '')}" placeholder="Optional"></td>
      <td><input type="text" name="airBarItem180mlPrice[]" value="${escapeHtml(item.price180ml || '')}" placeholder="Optional"></td>
      <td><input type="text" name="airBarItemCategory[]" list="air-category-options" value="${escapeHtml(cleanAirSheetText(item.category || 'Bar Menu', true))}" placeholder="Choose or type a category" required></td>
      <td><select name="airBarItemType[]"><option value="beverage" ${item.type !== 'food' ? 'selected' : ''}>Beverage</option><option value="food" ${item.type === 'food' ? 'selected' : ''}>Food</option></select></td>
      <td><input type="text" name="airBarItemDescription[]" value="${escapeHtml(item.description || '')}" placeholder="Optional description"></td>
      <td><label class="sheet-check"><input type="hidden" name="airBarItemBestSeller[]" value="${item.bestSeller ? 'true' : 'false'}"><input type="checkbox" data-bar-item-flag="bestSeller" ${item.bestSeller ? 'checked' : ''} aria-label="Best Seller"></label></td>
      <td><button type="button" class="remove-air-bar-item remove-air-item" aria-label="Remove bar row">×</button></td>
    </tr>`;
}

let airCategoryVisibility = {};

function isAlcoholCategory(category) {
  return /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisky|whiskey|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail)\b/i.test(category);
}

function syncAirCategoryVisibility() {
  const hidden = document.querySelector('[name="airCategoryVisibility"]');
  if (hidden) hidden.value = JSON.stringify(airCategoryVisibility);
}

function renderAirCategoryOptions(items = []) {
  const options = document.getElementById('air-category-options');
  if (!options) return;
  const categories = new Map();
  [...Object.keys(airCategoryVisibility), ...items.map((item) => item.category)]
    .map((category) => cleanAirSheetText(category, true))
    .filter(Boolean)
    .forEach((category) => categories.set(category.toLowerCase(), category));
  options.innerHTML = [...categories.values()]
    .sort((first, second) => first.localeCompare(second))
    .map((category) => `<option value="${escapeHtml(category)}"></option>`)
    .join('');
}

function renderAirCategoryControls(items = []) {
  const container = document.getElementById('air-category-controls');
  const categories = [...new Set(items.map((item) => item.category || 'Menu'))];
  const barCategories = new Set(items.filter((item) => item.isBar).map((item) => item.category || 'Bar Menu'));
  categories.forEach((category) => {
    if (!airCategoryVisibility[category]) {
      airCategoryVisibility[category] = { table: true, card: !barCategories.has(category) && !isAlcoholCategory(category) };
    }
  });
  renderAirCategoryOptions(items);
  if (!container) return;
  container.innerHTML = categories.length ? categories.map((category) => {
    const setting = airCategoryVisibility[category];
    return `<div class="category-control-row" data-category="${escapeHtml(category)}">
      <strong>${escapeHtml(category)}</strong>
      <label><input type="checkbox" data-view="table" ${setting.table !== false ? 'checked' : ''}> Table QR</label>
      <label><input type="checkbox" data-view="card" ${setting.card !== false ? 'checked' : ''}> Business Card QR</label>
    </div>`;
  }).join('') : '<p class="air-empty">Add or import menu items to configure category visibility.</p>';
  syncAirCategoryVisibility();
}

function renderAirItems(items = []) {
  const container = document.getElementById('air-items-container');
  if (!container) return;
  container.innerHTML = items.map((item, index) => airItemMarkup(item, index)).join('');
  if (!items.length) container.innerHTML = '<tr class="air-empty-row"><td colspan="13"><p class="air-empty">Upload a CSV, paste from Excel, or add your first menu item.</p></td></tr>';
  renderAirCategoryControls([...items, ...airBarSheetItems()]);
}

function airSheetItems() {
  return [...document.querySelectorAll('#air-items-container .air-item-entry')].map((row) => {
    const category = row.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu';
    return {
      name: row.querySelector('[name="airItemName[]"]')?.value.trim() || '',
      price: row.querySelector('[name="airItemPrice[]"]')?.value.trim() || '',
      fullPrice: row.querySelector('[name="airItemFullPrice[]"]')?.value.trim() || '',
      halfPrice: row.querySelector('[name="airItemHalfPrice[]"]')?.value.trim() || '',
      withBonePrice: row.querySelector('[name="airItemWithBonePrice[]"]')?.value.trim() || '',
      bonelessPrice: row.querySelector('[name="airItemBonelessPrice[]"]')?.value.trim() || '',
      category,
      type: row.querySelector('[name="airItemType[]"]')?.value === 'beverage' ? 'beverage' : 'food',
      dietary: row.querySelector('[name="airItemDietary[]"]')?.value || dietaryFromAirCategory(category),
      description: row.querySelector('[name="airItemDescription[]"]')?.value.trim() || '',
      bestSeller: row.querySelector('[data-item-flag="bestSeller"]')?.checked || false,
      mustHave: row.querySelector('[data-item-flag="mustHave"]')?.checked || false,
      gravyStyleAvailable: row.querySelector('[data-item-flag="gravyStyleAvailable"]')?.checked || false
    };
  }).filter((item) => item.name);
}

function airBarSheetItems() {
  return [...document.querySelectorAll('#air-bar-items-container .air-bar-item-entry')].map((row) => ({
    name: row.querySelector('[name="airBarItemName[]"]')?.value.trim() || '',
    price: row.querySelector('[name="airBarItemPrice[]"]')?.value.trim() || '',
    price30ml: row.querySelector('[name="airBarItem30mlPrice[]"]')?.value.trim() || '',
    price60ml: row.querySelector('[name="airBarItem60mlPrice[]"]')?.value.trim() || '',
    price90ml: row.querySelector('[name="airBarItem90mlPrice[]"]')?.value.trim() || '',
    price180ml: row.querySelector('[name="airBarItem180mlPrice[]"]')?.value.trim() || '',
    category: row.querySelector('[name="airBarItemCategory[]"]')?.value.trim() || 'Bar Menu',
    type: row.querySelector('[name="airBarItemType[]"]')?.value === 'food' ? 'food' : 'beverage',
    description: row.querySelector('[name="airBarItemDescription[]"]')?.value.trim() || '',
    bestSeller: row.querySelector('[data-bar-item-flag="bestSeller"]')?.checked || false,
    isBar: true
  })).filter((item) => item.name);
}

function renderAirBarItems(items = []) {
  const container = document.getElementById('air-bar-items-container');
  if (!container) return;
  container.innerHTML = items.map((item, index) => airBarItemMarkup(item, index)).join('');
  if (!items.length) container.innerHTML = '<tr class="air-empty-row"><td colspan="11"><p class="air-empty">Upload a Bar Menu file, paste spreadsheet rows, or add the first bar item.</p></td></tr>';
  renderAirCategoryControls([...airSheetItems(), ...items]);
}

function dedupeAirSheetItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.category}::${item.name}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fillAirMenu(menu = {}) {
  setField('airMenuTitle', menu.pageTitle);
  setField('airMenuSubtitle', menu.pageSubtitle);
  setField('airMenuNote', menu.note);
  setField('airSourceFileName', menu.sourceFileName);
  setField('airBarSourceFileName', menu.barSourceFileName);
  setField('airCardOrderPhone', menu.cardOrderPhone);
  setField('airService1Open', menu.serviceWindows?.[0]?.open || '12:30');
  setField('airService1Close', menu.serviceWindows?.[0]?.close || '15:00');
  setField('airService2Open', menu.serviceWindows?.[1]?.open || '18:30');
  setField('airService2Close', menu.serviceWindows?.[1]?.close || '00:00');
  setField('airReopensAt', menu.reopensAt || '');
  setField('airClosureMessage', menu.closureMessage || '');
  const toggles = {
    airTableLive: menu.tableLive !== false,
    airCardLive: menu.cardLive !== false,
    airShowTablePrices: menu.showTablePrices !== false,
    airShowCardPrices: menu.showCardPrices === true,
    airCardCallEnabled: menu.cardCallEnabled === true,
    airTableDirectOrders: menu.tableDirectOrders === true,
    airCardDirectOrders: menu.cardDirectOrders !== false,
    airRestaurantClosed: menu.restaurantClosed === true
  };
  Object.entries(toggles).forEach(([name, checked]) => {
    const field = document.querySelector(`[name="${name}"]`);
    if (field) field.checked = checked;
  });
  airCategoryVisibility = menu.categoryVisibility && typeof menu.categoryVisibility === 'object' ? { ...menu.categoryVisibility } : {};
  renderAirItems(Array.isArray(menu.items) ? menu.items : []);
  renderAirBarItems(Array.isArray(menu.barItems) ? menu.barItems : []);
}

function setupAirMenuEditor() {
  const container = document.getElementById('air-items-container');
  const addButton = document.getElementById('add-air-item');
  const extractButton = document.getElementById('extract-air-menu');
  const categoryControls = document.getElementById('air-category-controls');
  if (!container) return;

  addButton?.addEventListener('click', () => {
    container.querySelector('.air-empty-row')?.remove();
    container.insertAdjacentHTML('beforeend', airItemMarkup({}, container.querySelectorAll('.air-item-entry').length));
    container.querySelector('.air-item-entry:last-child [name="airItemName[]"]')?.focus();
  });

  container.addEventListener('click', (event) => {
    if (!event.target.matches('.remove-air-item')) return;
    event.target.closest('.air-item-entry')?.remove();
    if (!container.querySelector('.air-item-entry')) renderAirItems([]);
    else renderAirCategoryControls([...container.querySelectorAll('.air-item-entry')].map((entry) => ({
      category: entry.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu'
    })).concat(airBarSheetItems()));
  });

  container.addEventListener('input', (event) => {
    if (event.target.matches('[name="airItemCategory[]"]')) {
      syncDietaryPickerFromCategory(event.target.closest('.air-item-entry'));
      return;
    }
    const items = [...container.querySelectorAll('.air-item-entry')].map((entry) => ({
      category: entry.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu'
    }));
    renderAirCategoryControls([...items, ...airBarSheetItems()]);
  });

  container.addEventListener('change', async (event) => {
    if (event.target.matches('[name="airItemCategory[]"]')) {
      syncDietaryPickerFromCategory(event.target.closest('.air-item-entry'));
      renderAirCategoryControls([...airSheetItems(), ...airBarSheetItems()]);
      return;
    }
    const dietary = event.target.closest('[data-dietary]');
    if (dietary) {
      const picker = dietary.closest('.dietary-picker');
      const hidden = picker?.querySelector('[name="airItemDietary[]"]');
      if (dietary.checked) picker.querySelectorAll('[data-dietary]').forEach((choice) => { if (choice !== dietary) choice.checked = false; });
      if (hidden) hidden.value = dietary.checked ? dietary.dataset.dietary : '';
      const row = dietary.closest('.air-item-entry');
      const status = document.getElementById('air-sheet-status');
      const payload = {
        name: row?.querySelector('[name="airItemName[]"]')?.value.trim() || '',
        category: row?.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu',
        dietary: hidden?.value || ''
      };
      if (status) { status.textContent = 'Saving dietary selection…'; status.style.color = '#6b7280'; }
      try {
        const response = await fetch('/api/admin/air-menu/dietary', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to save selection.');
        if (status) { status.textContent = `${payload.name}: ${payload.dietary === 'nonveg' ? 'Non-Veg' : payload.dietary === 'veg' ? 'Veg' : 'dietary selection cleared'} saved live.`; status.style.color = '#166534'; }
      } catch (error) {
        if (status) { status.textContent = error.message; status.style.color = '#b91c1c'; }
      }
      return;
    }
    const flag = event.target.closest('[data-item-flag]');
    if (!flag) return;
    const hidden = flag.closest('.sheet-check')?.querySelector('input[type="hidden"]');
    if (hidden) hidden.value = flag.checked ? 'true' : 'false';
    if (flag.dataset.itemFlag !== 'gravyStyleAvailable') return;

    const row = flag.closest('.air-item-entry');
    const status = document.getElementById('air-sheet-status');
    const payload = {
      name: row?.querySelector('[name="airItemName[]"]')?.value.trim() || '',
      category: row?.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu',
      gravyStyleAvailable: flag.checked
    };
    if (status) { status.textContent = 'Saving Gravy / Semi-Gravy setting…'; status.style.color = '#6b7280'; }
    try {
      const response = await fetch('/api/admin/air-menu/gravy-style', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save setting.');
      if (status) { status.textContent = `${payload.name}: Gravy / Semi-Gravy ${payload.gravyStyleAvailable ? 'enabled' : 'disabled'} and saved live.`; status.style.color = '#166534'; }
    } catch (error) {
      if (status) { status.textContent = error.message; status.style.color = '#b91c1c'; }
    }
  });

  container.addEventListener('paste', (event) => {
    const target = event.target.closest('input, select');
    const clipboard = event.clipboardData?.getData('text/plain') || '';
    if (!target || (!clipboard.includes('\t') && !clipboard.includes('\n'))) return;
    event.preventDefault();
    const pastedRows = clipboard.replace(/\r/g, '').split('\n').filter((row) => row.trim()).map((row) => row.split('\t'));
    const fields = ['bestSeller', 'mustHave', 'gravyStyleAvailable', 'airItemName[]', 'airItemPrice[]', 'airItemFullPrice[]', 'airItemHalfPrice[]', 'airItemWithBonePrice[]', 'airItemBonelessPrice[]', 'airItemCategory[]', 'airItemType[]', 'dietary', 'airItemDescription[]'];
    const startColumn = Math.max(0, Math.min(12, target.closest('td')?.cellIndex || 0));
    let tableRows = [...container.querySelectorAll('.air-item-entry')];
    const startRow = Math.max(0, tableRows.indexOf(target.closest('.air-item-entry')));
    container.querySelector('.air-empty-row')?.remove();

    pastedRows.forEach((cells, rowOffset) => {
      while (tableRows.length <= startRow + rowOffset) {
        container.insertAdjacentHTML('beforeend', airItemMarkup({}, tableRows.length));
        tableRows = [...container.querySelectorAll('.air-item-entry')];
      }
      const row = tableRows[startRow + rowOffset];
      cells.slice(0, 13 - startColumn).forEach((value, columnOffset) => {
        const fieldName = fields[startColumn + columnOffset];
        if (fieldName === 'dietary') {
          const dietaryValue = /non[\s-]?veg/i.test(value) ? 'nonveg' : /veg/i.test(value) ? 'veg' : '';
          const checkbox = row.querySelector(`[data-dietary="${dietaryValue}"]`);
          if (checkbox) { checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles:true })); }
          return;
        }
        if (['bestSeller', 'mustHave', 'gravyStyleAvailable'].includes(fieldName)) {
          const checkbox = row.querySelector(`[data-item-flag="${fieldName}"]`);
          const checked = /^(1|true|yes|y|checked|best seller|must have|must try|popular|gravy|semi[-\s]?gravy)$/i.test(value.trim());
          if (checkbox) { checkbox.checked = checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
          return;
        }
        const field = row.querySelector(`[name="${fieldName}"]`);
        if (!field) return;
        const cleanValue = value.trim();
        field.value = fieldName === 'airItemType[]'
          ? (/beverage|drink/i.test(cleanValue) ? 'beverage' : 'food')
          : cleanValue;
      });
    });

    renderAirItems(dedupeAirSheetItems(airSheetItems()));
  });

  categoryControls?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[data-view]');
    if (!checkbox) return;
    const category = checkbox.closest('[data-category]')?.dataset.category;
    if (!category) return;
    airCategoryVisibility[category] ||= { table: true, card: !isAlcoholCategory(category) };
    airCategoryVisibility[category][checkbox.dataset.view] = checkbox.checked;
    syncAirCategoryVisibility();
  });

  extractButton?.addEventListener('click', async () => {
    const fileInput = document.getElementById('air-menu-file');
    const status = document.getElementById('air-extract-status');
    const file = fileInput?.files?.[0];
    if (!file) { status.textContent = 'Choose a PDF, CSV, or XLSX file first.'; status.style.color = '#b91c1c'; return; }
    extractButton.disabled = true;
    status.textContent = /\.(csv|xlsx)$/i.test(file.name)
      ? 'Reading spreadsheet rows and organising menu items…'
      : 'Scanning the PDF and organising menu items… This can take a few minutes for image-only PDFs.';
    status.style.color = '#6b7280';
    try {
      const data = new FormData();
      data.append('menuFile', file);
      const response = await fetch('/api/admin/air-menu/extract', { method: 'POST', body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'PDF analysis failed.');
      const importedItems = dedupeAirSheetItems(result.items || []);
      const importedCategories = new Set(importedItems.map((item) => cleanAirSheetText(item.category || 'Menu', true).toLowerCase()));
      const preservedItems = airSheetItems().filter((item) => !importedCategories.has(cleanAirSheetText(item.category, true).toLowerCase()));
      renderAirItems(dedupeAirSheetItems([...preservedItems, ...importedItems]));
      setField('airSourceFileName', result.fileName || file.name);
      const method = result.extractionMethod === 'ocr' ? 'local OCR' : result.extractionMethod === 'csv' ? 'CSV columns' : result.extractionMethod === 'xlsx' ? 'XLSX columns' : 'embedded PDF text';
      const sourceDetail = /^(csv|xlsx)$/.test(result.extractionMethod) ? '' : ` from ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}`;
      status.textContent = result.warning || `Updated ${importedCategories.size} categor${importedCategories.size === 1 ? 'y' : 'ies'} with ${importedItems.length} unique items${sourceDetail} using ${method}. Other categories were preserved.`;
      status.style.color = result.warning ? '#92400e' : '#166534';
    } catch (error) {
      status.textContent = error.message || 'PDF analysis failed.';
      status.style.color = '#b91c1c';
    } finally {
      extractButton.disabled = false;
    }
  });
}

function setupAirBarMenuEditor() {
  const container = document.getElementById('air-bar-items-container');
  const addButton = document.getElementById('add-air-bar-item');
  const extractButton = document.getElementById('extract-air-bar-menu');
  if (!container) return;

  const refreshCategories = () => renderAirCategoryControls([...airSheetItems(), ...airBarSheetItems()]);
  addButton?.addEventListener('click', () => {
    container.querySelector('.air-empty-row')?.remove();
    container.insertAdjacentHTML('beforeend', airBarItemMarkup({}, container.querySelectorAll('.air-bar-item-entry').length));
    container.querySelector('.air-bar-item-entry:last-child [name="airBarItemName[]"]')?.focus();
    refreshCategories();
  });

  container.addEventListener('click', (event) => {
    if (!event.target.matches('.remove-air-bar-item')) return;
    event.target.closest('.air-bar-item-entry')?.remove();
    if (!container.querySelector('.air-bar-item-entry')) renderAirBarItems([]);
    refreshCategories();
  });
  container.addEventListener('input', (event) => {
    if (event.target.matches('[name="airBarItemCategory[]"]')) return;
    refreshCategories();
  });
  container.addEventListener('change', (event) => {
    if (event.target.matches('[name="airBarItemCategory[]"]')) {
      refreshCategories();
      return;
    }
    const flag = event.target.closest('[data-bar-item-flag]');
    if (!flag) return;
    const hidden = flag.closest('.sheet-check')?.querySelector('input[type="hidden"]');
    if (hidden) hidden.value = flag.checked ? 'true' : 'false';
  });

  container.addEventListener('paste', (event) => {
    const target = event.target.closest('input, select');
    const clipboard = event.clipboardData?.getData('text/plain') || '';
    if (!target || (!clipboard.includes('\t') && !clipboard.includes('\n'))) return;
    event.preventDefault();
    const pastedRows = clipboard.replace(/\r/g, '').split('\n').filter((row) => row.trim()).map((row) => row.split('\t'));
    const fields = ['airBarItemName[]', 'airBarItemPrice[]', 'airBarItem30mlPrice[]', 'airBarItem60mlPrice[]', 'airBarItem90mlPrice[]', 'airBarItem180mlPrice[]', 'airBarItemCategory[]', 'airBarItemType[]', 'airBarItemDescription[]', 'bestSeller'];
    const startColumn = Math.max(0, Math.min(9, target.closest('td')?.cellIndex || 0));
    let tableRows = [...container.querySelectorAll('.air-bar-item-entry')];
    const startRow = Math.max(0, tableRows.indexOf(target.closest('.air-bar-item-entry')));
    container.querySelector('.air-empty-row')?.remove();
    pastedRows.forEach((cells, rowOffset) => {
      while (tableRows.length <= startRow + rowOffset) {
        container.insertAdjacentHTML('beforeend', airBarItemMarkup({}, tableRows.length));
        tableRows = [...container.querySelectorAll('.air-bar-item-entry')];
      }
      const row = tableRows[startRow + rowOffset];
      cells.slice(0, 10 - startColumn).forEach((value, columnOffset) => {
        const fieldName = fields[startColumn + columnOffset];
        if (fieldName === 'bestSeller') {
          const checkbox = row.querySelector('[data-bar-item-flag="bestSeller"]');
          checkbox.checked = /^(1|true|yes|y|checked|best seller|popular)$/i.test(value.trim());
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        const field = row.querySelector(`[name="${fieldName}"]`);
        if (!field) return;
        field.value = fieldName === 'airBarItemType[]' ? (/food/i.test(value) ? 'food' : 'beverage') : value.trim();
      });
    });
    renderAirBarItems(dedupeAirSheetItems(airBarSheetItems()));
  });

  extractButton?.addEventListener('click', async () => {
    const fileInput = document.getElementById('air-bar-menu-file');
    const status = document.getElementById('air-bar-extract-status');
    const file = fileInput?.files?.[0];
    if (!file) { status.textContent = 'Choose a Bar Menu PDF, CSV, or XLSX file first.'; status.style.color = '#b91c1c'; return; }
    extractButton.disabled = true;
    status.textContent = /\.(csv|xlsx)$/i.test(file.name) ? 'Reading Bar Menu spreadsheet…' : 'Scanning the Bar Menu PDF with local OCR…';
    status.style.color = '#6b7280';
    try {
      const data = new FormData();
      data.append('menuFile', file);
      const response = await fetch('/api/admin/air-menu/extract-bar', { method: 'POST', body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Bar Menu extraction failed.');
      const importedItems = dedupeAirSheetItems(result.items || []);
      const importedCategories = new Set(importedItems.map((item) => cleanAirSheetText(item.category || 'Bar Menu', true).toLowerCase()));
      const preservedItems = airBarSheetItems().filter((item) => !importedCategories.has(cleanAirSheetText(item.category, true).toLowerCase()));
      renderAirBarItems(dedupeAirSheetItems([...preservedItems, ...importedItems]));
      setField('airBarSourceFileName', result.fileName || file.name);
      const method = result.extractionMethod === 'ocr' ? 'local OCR' : result.extractionMethod === 'xlsx' ? 'XLSX columns' : result.extractionMethod === 'csv' ? 'CSV columns' : 'embedded PDF text';
      status.textContent = result.warning || `Updated ${importedCategories.size} bar categor${importedCategories.size === 1 ? 'y' : 'ies'} with ${importedItems.length} unique items using ${method}. Other bar categories were preserved.`;
      status.style.color = result.warning ? '#92400e' : '#166534';
    } catch (error) {
      status.textContent = error.message || 'Bar Menu extraction failed.';
      status.style.color = '#b91c1c';
    } finally {
      extractButton.disabled = false;
    }
  });
}

function fillBlogs(blogs = {}) {
  setField('blogPageTitle', blogs.pageTitle);
  setField('blogPageSubtitle', blogs.pageSubtitle);

  const blogsContainer = document.getElementById('blogs-container');
  if (blogsContainer && Array.isArray(blogs.posts) && blogs.posts.length) {
    blogsContainer.innerHTML = blogs.posts.map((post, index) => blogEntryMarkup(post, index)).join('');
  }
}

function fillAbout(about = {}) {
  setField('aboutHeroTitle', about.heroTitle);
  setField('aboutHeroSubtitle', about.heroSubtitle);
  setField('aboutStoryTitle', about.storyTitle);
  setField('aboutStoryText', about.storyText);
}

function indexRepeatingFileInputs(form, entrySelector, inputPrefix) {
  form.querySelectorAll(entrySelector).forEach((entry, index) => {
    const input = entry.querySelector(`input[type="file"][name^="${inputPrefix}"]`);
    if (input) input.name = `${inputPrefix}_${index}`;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

async function compressImageFile(file, options = {}) {
  if (!file || !file.type.startsWith('image/')) return file;
  if (file.type === 'image/webp' && file.size <= (options.maxBytes || 900 * 1024)) return file;

  const maxDimension = options.maxDimension || 1400;
  const maxBytes = options.maxBytes || 900 * 1024;
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });

    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    let quality = 0.82;
    let blob = await canvasToBlob(canvas, 'image/webp', quality);
    while (blob && blob.size > maxBytes && quality > 0.52) {
      quality -= 0.08;
      blob = await canvasToBlob(canvas, 'image/webp', quality);
    }

    if (!blob) return file;
    const outputName = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], outputName, { type: 'image/webp', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function buildOptimizedFormData(form) {
  const formData = new FormData(form);
  const fileInputs = [...form.querySelectorAll('input[type="file"]')]
    .filter((input) => input.files && input.files.length > 0);

  for (const input of fileInputs) {
    const optimizedFile = await compressImageFile(input.files[0]);
    formData.set(input.name, optimizedFile);
  }

  return formData;
}

function insertAroundSelection(textarea, before, after = '', fallback = '') {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const selected = textarea.value.slice(start, end);
  const text = selected || fallback;
  const insert = `${before}${text}${after}`;
  textarea.setRangeText(insert, start, end, 'end');
  textarea.focus();

  if (!selected && fallback) {
    const selectionStart = start + before.length;
    const selectionEnd = selectionStart + fallback.length;
    textarea.setSelectionRange(selectionStart, selectionEnd);
  }
}

function setupRichTextToolbar() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.editor-toolbar button');
    if (!button) return;

    const editor = button.closest('.rich-text-editor');
    const textarea = editor && editor.querySelector('textarea');
    if (!textarea) return;

    const action = button.title;
    if (action === 'Bold') {
      insertAroundSelection(textarea, '<strong>', '</strong>', 'bold text');
    } else if (action === 'Italic') {
      insertAroundSelection(textarea, '<em>', '</em>', 'italic text');
    } else if (action === 'Heading 2') {
      insertAroundSelection(textarea, '<h2>', '</h2>\n\n', 'Subheading');
    } else if (action === 'Paragraph') {
      insertAroundSelection(textarea, '<p>', '</p>\n\n', 'Paragraph text');
    } else if (action === 'Insert Link') {
      const url = window.prompt('Enter the link URL, including https://');
      if (!url) return;
      insertAroundSelection(textarea, `<a href="${escapeHtml(url)}">`, '</a>', 'link text');
    }
  });
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

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const renderAiItems = (id, items, mapper) => {
  const container = document.getElementById(id);
  if (!container) return;
  container.innerHTML = (items || []).map((item) => {
    const mapped = mapper(item);
    return `
      <div class="growth-item">
        <strong>${escapeHtml(mapped.title)}</strong>
        <span>${escapeHtml(mapped.detail)}</span>
        ${mapped.tag ? `<div class="growth-tag">${escapeHtml(mapped.tag)}</div>` : ''}
      </div>
    `;
  }).join('');
};

function renderAiGrowthPlan(plan) {
  const results = document.getElementById('growth-ai-results');
  const summary = document.getElementById('growth-ai-summary');
  if (results) results.style.display = 'block';
  if (summary) summary.textContent = plan.summary || '';

  renderAiItems('growth-ai-trends', plan.trendSignals, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.priority
  }));

  renderAiItems('growth-ai-actions', plan.priorityActions, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.impact
  }));

  renderAiItems('growth-ai-seo', plan.seoWinningMoves, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.searchTarget
  }));

  renderAiItems('growth-ai-content', plan.contentIdeas, (item) => ({
    title: item.title,
    detail: `${item.searchIntent} ${item.outline} Keywords: ${(item.keywords || []).join(', ')}`,
    tag: 'Content'
  }));

  renderAiItems('growth-ai-ads', plan.adIdeas, (item) => ({
    title: item.campaign,
    detail: `${item.audience} ${item.message} Landing page: ${item.landingPage}`,
    tag: 'Ads'
  }));

  renderAiItems('growth-ai-missing', plan.missingWebsiteItems, (item) => ({
    title: item,
    detail: 'Add or improve this to strengthen local SEO and conversion.',
    tag: 'Missing'
  }));

  const sources = document.getElementById('growth-ai-sources');
  if (sources) {
    sources.innerHTML = (plan.sources || []).map((source) => `
      <div class="growth-item">
        <strong>${escapeHtml(source.title)}</strong>
        <a class="growth-source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>
      </div>
    `).join('');
  }
}

function setupAiGrowthButton() {
  const button = document.getElementById('generate-ai-growth');
  const status = document.getElementById('growth-ai-status');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    if (status) {
      status.textContent = 'Scanning live trends and your website data...';
      status.style.color = '#6b7280';
    }

    try {
      const response = await fetch('/api/growth-ai', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'AI growth scan failed.');
      renderAiGrowthPlan(data.plan);
      if (status) {
        status.textContent = `AI growth plan generated at ${new Date(data.generatedAt).toLocaleString()}.`;
        status.style.color = '#166534';
      }
    } catch (error) {
      if (status) {
        status.textContent = error.message || 'AI growth scan failed.';
        status.style.color = '#b91c1c';
      }
    } finally {
      button.disabled = false;
    }
  });
}

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
  const scoreLabel = document.getElementById('growth-score-label');
  const scorePercent = Math.round((score / 6) * 100);
  if (scoreText) {
    scoreText.textContent = `${scorePercent}% ready`;
    if (score === 6) {
      scoreText.style.color = '#166534';
    } else {
      scoreText.style.color = '#d62828';
    }
  }
  if (scoreLabel) {
    scoreLabel.textContent = score === 6
      ? '✅ Green signal: all core readiness items are complete. Well done!'
      : 'Use Refresh progress after saving content changes to update the readiness score.';
  }

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
  const seoRoadmap = [
    {
      title: 'Win Google Maps first',
      detail: global.googleBusinessUrl
        ? 'Your Google Business Profile is linked. Keep it active with weekly dish photos, fresh posts, accurate hours, menu highlights, and review replies using phrases like Chinese food in Colva and Goan seafood near Colva Beach.'
        : 'Add your Google Business Profile URL in Footer & Settings. Then keep the profile updated weekly with photos, menu items, posts, services, attributes, and review replies.',
      tag: 'Local Pack'
    },
    {
      title: 'Build one page for each money search',
      detail: `Create focused website sections or landing pages for searches like "${primaryCuisine} in ${primaryLocation}", "${secondaryCuisine} near ${primaryLocation}", "family restaurant in ${secondaryLocation}", and "restaurants near Colva Beach". Each page needs unique text, photos, menu links, map, phone, and ordering buttons.`,
      tag: 'Pages'
    },
    {
      title: 'Turn the menu into SEO content',
      detail: hasMenuDepth
        ? 'You have enough menu depth to start ranking pages around individual dishes. Add prices, original photos, descriptions, spice level, cuisine category, and internal links from blogs to each signature dish.'
        : 'Add at least 8-12 dishes with categories, descriptions, and original photos. Google needs clear menu content to understand what food searches Red Lantern should rank for.',
      tag: 'Menu SEO'
    },
    {
      title: 'Publish blog clusters, not random posts',
      detail: hasBlogEngine
        ? `You have ${posts.length} blog post(s). Next, create clusters around Colva restaurants, Chinese food, Goan seafood, family dining, delivery/order searches, and tourist food guides. Link every post back to Menu and Contact.`
        : 'Publish at least 3 starter posts: best Chinese food in Colva, Goan seafood near Colva Beach, and family restaurant in South Goa. Then expand each topic into related posts.',
      tag: 'Content'
    },
    {
      title: 'Beat competitors with comparison intent',
      detail: competitors.length
        ? `You are tracking ${competitors.slice(0, 4).join(', ')}. Create comparison-style content that highlights Red Lantern strengths: cuisine range, ambience, location, value, delivery links, photos, and signature dishes. Keep the tone factual, not negative.`
        : 'Add competitor names in Market Research Inputs. The AI scanner can then generate comparison topics and ad angles against restaurants people already search for.',
      tag: 'Competitors'
    },
    {
      title: 'Improve trust signals everywhere',
      detail: 'Add real customer reviews, restaurant photos, chef/story details, exact address, phone, map, opening hours, order links, and social profiles. These help both Google and visitors trust the business.',
      tag: 'Trust'
    },
    {
      title: 'Track what is working',
      detail: hasAds
        ? 'Tracking is partly configured. Use GA4/Search Console/Google Business Profile insights to watch calls, directions, menu clicks, order clicks, and the searches people use to find you.'
        : 'Add GA4, Google Search Console, Google Business Profile insights, and ad conversion tracking before serious ad spend. Ranking work needs measurement.',
      tag: 'Tracking'
    }
  ];

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
  renderGrowthItems('growth-seo-roadmap', seoRoadmap);
  renderGrowthItems('growth-blog-ideas', blogIdeas);
  renderGrowthItems('growth-ad-ideas', adIdeas);
  renderGrowthItems('growth-checklist', checklist);
}

async function refreshGrowthProgress() {
  const button = document.getElementById('refresh-growth-progress');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/admin/content');
    if (!response.ok) throw new Error('Unable to refresh progress.');
    const content = await response.json();
    buildGrowthDashboard(content);
  } catch (error) {
    const scoreLabel = document.getElementById('growth-score-label');
    if (scoreLabel) scoreLabel.textContent = error.message || 'Unable to refresh progress.';
  } finally {
    if (button) button.disabled = false;
  }
}

function setupGrowthRefreshButton() {
  const button = document.getElementById('refresh-growth-progress');
  if (!button) return;
  button.addEventListener('click', refreshGrowthProgress);
}

let diagnosticsLogs = [];
const selectedLogIds = new Set();

function formatLogTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(new Date(value));
}

function getVisibleLogs() {
  const filter = document.getElementById('log-level-filter')?.value || 'all';
  return filter === 'all' ? diagnosticsLogs : diagnosticsLogs.filter((log) => log.level === filter);
}

function getLogId(log) {
  return String(log.id || `${log.created_at}-${log.message}`);
}

function logRoute(log) {
  return [log.method, log.path].filter(Boolean).join(' ');
}

function formatLogForCopy(log) {
  const details = log.details && Object.keys(log.details).length
    ? JSON.stringify(log.details, null, 2)
    : '';

  return [
    `Message: ${log.message || 'Website event'}`,
    `Level: ${log.level || 'info'}`,
    `When: ${formatLogTime(log.created_at)}`,
    `Type: ${log.category || ''}`,
    `Where: ${log.location || log.path || ''}`,
    `Route: ${logRoute(log)}`,
    `Status: ${log.status_code || ''}`,
    `Load time: ${log.duration_ms ? `${log.duration_ms}ms` : ''}`,
    `IP hash: ${log.ip_hash || ''}`,
    `Suggested fix: ${log.solution || 'Review this event and the details below.'}`,
    details ? `Details:\n${details}` : ''
  ].filter(Boolean).join('\n');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function updateLogCopyStatus(message) {
  const status = document.getElementById('log-copy-status');
  if (!status) return;
  status.textContent = message || `${selectedLogIds.size} selected`;
}

function pruneSelectedLogs() {
  const loadedIds = new Set(diagnosticsLogs.map(getLogId));
  [...selectedLogIds].forEach((id) => {
    if (!loadedIds.has(id)) selectedLogIds.delete(id);
  });
}

async function copyLogs(logs) {
  if (!logs.length) {
    updateLogCopyStatus('Select at least one log to copy.');
    return;
  }

  try {
    await copyTextToClipboard(logs.map(formatLogForCopy).join('\n\n---\n\n'));
    updateLogCopyStatus(`Copied ${logs.length} log${logs.length === 1 ? '' : 's'}.`);
  } catch (error) {
    updateLogCopyStatus('Copy failed. Select the text and try again.');
    reportClientDiagnostic({
      category: 'frontend',
      level: 'error',
      message: `Admin log copy failed: ${error.message}`,
      source: 'admin-cms.js copyLogs',
      stack: error.stack || ''
    });
  }
}

function renderHealth(data = {}) {
  const grid = document.getElementById('health-grid');
  const status = document.getElementById('health-status');
  if (!grid) return;
  const checks = data.checks || {};
  const entries = Object.entries(checks);
  grid.innerHTML = entries.length ? entries.map(([name, check]) => `
    <div class="health-item ${check.ok ? 'ok' : 'bad'}">
      <strong>${check.ok ? 'Ready' : 'Needs attention'}: ${escapeHtml(name)}</strong>
      <span>${escapeHtml(check.message || '')}</span>
    </div>
  `).join('') : '<p class="log-status">No health data available.</p>';
  if (status) status.textContent = data.checkedAt
    ? `${data.ok ? 'Healthy' : 'Needs attention'} · ${formatLogTime(data.checkedAt)}`
    : 'Health check unavailable.';
}

async function refreshHealth() {
  const status = document.getElementById('health-status');
  if (status) status.textContent = 'Checking...';
  try {
    const response = await fetch('/api/admin/health', { cache: 'no-store' });
    const data = await response.json();
    renderHealth(data);
  } catch (error) {
    if (status) status.textContent = error.message || 'Health check failed.';
    reportClientDiagnostic({
      category: 'frontend',
      level: 'error',
      message: `Admin health check UI failed: ${error.message}`,
      source: 'admin-cms.js refreshHealth',
      stack: error.stack || ''
    });
  }
}

function renderLogs() {
  const list = document.getElementById('logs-list');
  const status = document.getElementById('logs-status');
  if (!list) return;
  pruneSelectedLogs();
  const logs = getVisibleLogs();
  if (status) status.textContent = `${logs.length} shown · ${diagnosticsLogs.length} loaded`;
  updateLogCopyStatus();
  if (!logs.length) {
    list.innerHTML = '<p class="log-status">No logs for this filter. Nice and quiet.</p>';
    return;
  }

  list.innerHTML = logs.map((log) => {
    const details = log.details && Object.keys(log.details).length
      ? JSON.stringify(log.details, null, 2)
      : '';
    const logId = getLogId(log);
    const isSelected = selectedLogIds.has(logId);
    return `
      <article class="log-entry ${escapeHtml(log.level || 'info')} ${isSelected ? 'selected' : ''}" data-log-id="${escapeHtml(logId)}">
        <div class="log-entry-header">
          <h3>${escapeHtml(log.message || 'Website event')}</h3>
          <div class="log-entry-actions">
            <label class="log-select">
              <input type="checkbox" class="log-select-input" ${isSelected ? 'checked' : ''}>
              Select
            </label>
            <button type="button" class="log-copy-btn copy-single-log">Copy</button>
            <span class="log-badge ${escapeHtml(log.level || 'info')}">${escapeHtml(log.level || 'info')}</span>
          </div>
        </div>
        <div class="log-meta">
          <span><strong>When:</strong> ${escapeHtml(formatLogTime(log.created_at))}</span>
          <span><strong>Type:</strong> ${escapeHtml(log.category || '')}</span>
          <span><strong>Where:</strong> ${escapeHtml(log.location || log.path || '')}</span>
          <span><strong>Route:</strong> ${escapeHtml(logRoute(log))}</span>
          <span><strong>Status:</strong> ${escapeHtml(log.status_code || '')}</span>
          <span><strong>Load time:</strong> ${log.duration_ms ? `${escapeHtml(log.duration_ms)}ms` : ''}</span>
          <span><strong>IP hash:</strong> ${escapeHtml(log.ip_hash || '')}</span>
        </div>
        <div class="log-solution"><strong>Suggested fix:</strong> ${escapeHtml(log.solution || 'Review this event and the details below.')}</div>
        ${details ? `<pre class="log-details">${escapeHtml(details)}</pre>` : ''}
      </article>
    `;
  }).join('');
}

async function refreshLogs() {
  const status = document.getElementById('logs-status');
  if (status) status.textContent = 'Loading logs...';
  try {
    const response = await fetch('/api/admin/logs?limit=100', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load diagnostics logs.');
    const data = await response.json();
    diagnosticsLogs = data.logs || [];
    pruneSelectedLogs();
    renderLogs();
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to load logs.';
    reportClientDiagnostic({
      category: 'frontend',
      level: 'error',
      message: `Admin logs UI failed: ${error.message}`,
      source: 'admin-cms.js refreshLogs',
      stack: error.stack || ''
    });
  }
}

async function clearLogs() {
  const status = document.getElementById('logs-status');
  if (!window.confirm('Clear all diagnostics logs?')) return;
  if (status) status.textContent = 'Clearing logs...';
  try {
    const response = await fetch('/api/admin/logs', { method: 'DELETE' });
    if (!response.ok) throw new Error('Unable to clear diagnostics logs.');
    selectedLogIds.clear();
    await refreshLogs();
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to clear logs.';
  }
}

function renderQrScans(data = {}) {
  const list = document.getElementById('qr-scans-list');
  const stats = document.getElementById('qr-scan-stats');
  const status = document.getElementById('qr-scans-status');
  if (!list || !stats) return;
  const summary = data.summary || {};
  const statItems = [
    ['Total scans', summary.total_scans || 0],
    ['Last 24 hours', summary.scans_24h || 0],
    ['Unique in 24h', summary.unique_24h || 0],
    ['Table QR', summary.table_scans || 0],
    ['Business Card QR', summary.card_scans || 0]
  ];
  stats.innerHTML = statItems.map(([label, value]) => `<div class="scan-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  const scans = data.scans || [];
  if (status) status.textContent = `${scans.length} recent scan${scans.length === 1 ? '' : 's'} loaded`;
  list.innerHTML = scans.length ? scans.map((scan) => {
    const details = scan.details || {};
    const place = [details.city, details.region, details.country].filter(Boolean).join(', ') || 'Approximate location unavailable';
    return `<article class="scan-entry">
      <div><strong>${escapeHtml(details.qrType || scan.message || 'QR scan')}</strong><span>${escapeHtml(formatLogTime(scan.created_at))}</span></div>
      <div><strong>${details.mode === 'card' ? 'Visiting-card menu' : 'In-store table menu'}</strong><span>Anonymous visitor: ${escapeHtml(scan.ip_hash || 'unavailable')} · ${escapeHtml(scan.visitor_scan_count || 1)} scan${Number(scan.visitor_scan_count || 1) === 1 ? '' : 's'}</span></div>
      <div><strong>${escapeHtml(place)}</strong><span>Approximate network location</span></div>
    </article>`;
  }).join('') : '<p class="log-status">No QR scans have been recorded yet.</p>';
}

async function refreshQrScans() {
  const status = document.getElementById('qr-scans-status');
  if (status) status.textContent = 'Loading scans...';
  try {
    const response = await fetch('/api/admin/qr-scans?limit=150', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load QR scan logs.');
    renderQrScans(data);
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to load QR scan logs.';
  }
}

async function clearQrScans() {
  if (!window.confirm('Clear all QR scan history?')) return;
  const status = document.getElementById('qr-scans-status');
  if (status) status.textContent = 'Clearing scan history...';
  try {
    const response = await fetch('/api/admin/qr-scans', { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to clear QR scan history.');
    await refreshQrScans();
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to clear QR scan history.';
  }
}

function setupQrScanDashboard() {
  document.getElementById('refresh-qr-scans')?.addEventListener('click', refreshQrScans);
  document.getElementById('clear-qr-scans')?.addEventListener('click', clearQrScans);
  refreshQrScans();
}

function setupDiagnosticsDashboard() {
  document.getElementById('refresh-health')?.addEventListener('click', refreshHealth);
  document.getElementById('refresh-logs')?.addEventListener('click', refreshLogs);
  document.getElementById('clear-logs')?.addEventListener('click', clearLogs);
  document.getElementById('log-level-filter')?.addEventListener('change', renderLogs);
  document.getElementById('select-visible-logs')?.addEventListener('click', () => {
    getVisibleLogs().forEach((log) => selectedLogIds.add(getLogId(log)));
    renderLogs();
  });
  document.getElementById('clear-selected-logs')?.addEventListener('click', () => {
    selectedLogIds.clear();
    renderLogs();
  });
  document.getElementById('copy-selected-logs')?.addEventListener('click', () => {
    const logs = diagnosticsLogs.filter((log) => selectedLogIds.has(getLogId(log)));
    copyLogs(logs);
  });
  document.getElementById('logs-list')?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('.log-select-input');
    if (!checkbox) return;
    const entry = checkbox.closest('.log-entry');
    const logId = entry?.dataset.logId;
    if (!logId) return;
    if (checkbox.checked) selectedLogIds.add(logId);
    else selectedLogIds.delete(logId);
    entry.classList.toggle('selected', checkbox.checked);
    updateLogCopyStatus();
  });
  document.getElementById('logs-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('.copy-single-log');
    if (!button) return;
    const logId = button.closest('.log-entry')?.dataset.logId;
    const log = diagnosticsLogs.find((item) => getLogId(item) === logId);
    if (log) copyLogs([log]);
  });
  refreshHealth();
  refreshLogs();
}

function setupGoogleReviewsSync() {
  const button = document.getElementById('sync-google-reviews');
  const status = document.getElementById('google-reviews-sync-status');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    if (status) {
      status.textContent = 'Fetching 5-star Google reviews...';
      status.style.color = '#6b7280';
    }

    try {
      const response = await fetch('/api/admin/google-reviews/sync', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to sync Google reviews.');

      renderHomeReviewEntries(data.reviews || []);
      if (status) {
        status.textContent = `Synced ${data.importedCount} new 5-star review${data.importedCount === 1 ? '' : 's'} (${data.totalFiveStar} total 5-star saved). Click Publish Changes to Home Page if you edit them.`;
        status.style.color = '#166534';
      }
    } catch (error) {
      if (status) {
        status.textContent = error.message || 'Unable to sync Google reviews.';
        status.style.color = '#b91c1c';
      }
    } finally {
      button.disabled = false;
    }
  });
}

fetch('/api/admin/content')
  .then((response) => response.ok ? response.json() : {})
  .then((content) => {
    fillHome(content.home);
    fillMenu(content.menu);
    fillAirMenu(content.airMenu);
    fillBlogs(content.blogs);
    setupBlogDescriptionGenerator();
    fillAbout(content.about);
    fillContact(content.contact);
    fillGlobal(content.global);
    buildGrowthDashboard(content);
  })
  .catch(() => {});

setupAiGrowthButton();
setupGrowthRefreshButton();
setupDiagnosticsDashboard();
setupQrScanDashboard();
setupGoogleReviewsSync();
setupRichTextToolbar();
setupBlogDescriptionGenerator();
setupAirMenuEditor();
setupAirBarMenuEditor();

document.querySelectorAll('.logout-btn:not(#clear-logs)').forEach((button) => {
  button.addEventListener('click', () => {
    window.location.href = '/';
  });
});

document.querySelectorAll('form[action^="/api/update-"]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus(form, 'Optimizing images...');
    indexRepeatingFileInputs(form, '.dish-entry', 'dishPhoto');
    indexRepeatingFileInputs(form, '.blog-entry', 'blogImage');
    indexRepeatingFileInputs(form, '.blog-entry', 'blogArticleImage');
    if (form.matches('form[action="/api/update-blogs"]')) {
      form.querySelectorAll('.blog-entry').forEach((entry) => updateBlogGeneratedDescriptions(entry));
    }

    try {
      const formData = await buildOptimizedFormData(form);
      setStatus(form, 'Saving...');
      const response = await fetch(form.action, {
        method: 'POST',
        body: formData
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      setStatus(form, 'Saved. Go to Growth Ideas and click Refresh progress to update the readiness score.');
    } catch (error) {
      setStatus(form, error.message || 'Save failed.', true);
    }
  });
});

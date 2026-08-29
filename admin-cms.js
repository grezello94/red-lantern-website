const setField = (name, value) => {
  const field = document.querySelector(`[name="${name}"]`);
  if (field && value !== undefined) field.value = value;
};
const applyProximityLock = (locked) => {
  document.querySelectorAll('.proximity-coordinate').forEach((field) => {
    field.readOnly = locked;
    field.classList.toggle('is-locked', locked);
  });
};
document.querySelector('[name="airProximityLocked"]')?.addEventListener('change', async (event) => {
  const lock = event.target;
  const locked = lock.checked;
  applyProximityLock(locked);
  lock.disabled = true;
  try {
    const response = await fetch('/api/admin/air-menu/proximity-lock', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to save the coordinate lock.');
  } catch (error) {
    lock.checked = !locked;
    applyProximityLock(!locked);
    alert(error.message || 'Unable to save the coordinate lock.');
  } finally {
    lock.disabled = false;
  }
});

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

let saveToastTimer = null;
function showSaveToast() {
  let toast = document.getElementById('admin-save-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-save-toast';
    toast.className = 'admin-save-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = '<span class="admin-save-toast-check" aria-hidden="true">✓</span><span>Changes saved</span>';
    document.body.appendChild(toast);
  }
  window.clearTimeout(saveToastTimer);
  toast.classList.remove('is-visible');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  saveToastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

const saveToastStyles = document.createElement('style');
saveToastStyles.textContent = `#admin-save-toast{position:fixed;left:50%;top:50%;z-index:10000;display:flex;align-items:center;gap:12px;padding:18px 24px;border:1px solid rgba(255,255,255,.7);border-radius:18px;color:#fff;background:linear-gradient(135deg,#14834a,#08713a);box-shadow:0 22px 60px rgba(4,70,35,.34);font:900 18px Manrope,Arial,sans-serif;opacity:0;pointer-events:none;transform:translate(-50%,-42%) scale(.9);transition:opacity .22s ease,transform .28s cubic-bezier(.2,.9,.2,1)}#admin-save-toast.is-visible{opacity:1;transform:translate(-50%,-50%) scale(1)}.admin-save-toast-check{display:grid;width:30px;height:30px;place-items:center;border-radius:50%;color:#08713a;background:#fff;font-size:19px;font-weight:900}@media(max-width:560px){#admin-save-toast{width:calc(100% - 40px);justify-content:center;padding:16px 18px;font-size:16px}}`;
document.head.appendChild(saveToastStyles);

function reportClientDiagnostic(payload) {
  try {
    const body = JSON.stringify({
      path: window.location.pathname,
      href: window.location.href,
      ...payload,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
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
    stack: event.error?.stack || '',
  });
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientDiagnostic({
    category: 'frontend',
    level: 'error',
    message: event.reason?.message || 'Admin browser promise failed.',
    source: 'admin browser promise',
    stack: event.reason?.stack || String(event.reason || ''),
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
  return cleanDescriptionText(
    sentences.find((sentence) => cleanDescriptionText(sentence).length >= 55) || sentences[0]
  );
};

const includesLocalContext = (value) => /red lantern|colva|south goa|goa/i.test(value);

function generatedBlogDescriptions(title, content) {
  const cleanTitle = cleanDescriptionText(title);
  const lead = firstUsefulSentence(content) || cleanTitle;
  const localPhrase = 'Red Lantern Restaurant in Colva, South Goa';

  const excerptSeed =
    cleanTitle && lead && !lead.toLowerCase().includes(cleanTitle.toLowerCase())
      ? `${cleanTitle}: ${lead}`
      : lead || cleanTitle;
  const excerpt = trimDescription(excerptSeed, 165);

  const leadHasTitle = cleanTitle && lead.toLowerCase().includes(cleanTitle.toLowerCase());
  const seoSeed =
    lead && !leadHasTitle
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
    const canUpdate =
      force || !excerptField.value.trim() || excerptField.dataset.generated === 'true';
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

  container
    .querySelectorAll('.blog-entry')
    .forEach((entry) => updateBlogGeneratedDescriptions(entry));
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
    'blogSectionSubtitle',
  ].forEach((name) => setField(name, home[name]));

  const heroPreview = document
    .querySelector('input[name="heroImage"]')
    ?.closest('.form-group')
    ?.querySelector('.image-preview');
  if (heroPreview && home.heroImage) heroPreview.src = home.heroImage;

  const welcomePreview = document
    .querySelector('input[name="welcomeImage"]')
    ?.closest('.form-group')
    ?.querySelector('.image-preview');
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
  reviewsContainer.innerHTML = reviews
    .map((review, index) => reviewEntryMarkup(review, index))
    .join('');
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
    dishesContainer.innerHTML = menu.dishes
      .map((dish, index) => dishEntryMarkup(dish, index))
      .join('');
  }
}

function cleanAirSheetText(value, isCategory = false) {
  let text = String(value || '')
    .replace(/[.…·]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
let airCategoryOrder = [];
let airCategoryGroups = new Map();

function isAlcoholCategory(category) {
  return /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisky|whiskey|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail)\b/i.test(
    category
  );
}

function syncAirCategoryVisibility() {
  const hidden = document.querySelector('[name="airCategoryVisibility"]');
  if (hidden) hidden.value = JSON.stringify(airCategoryVisibility);
}

function syncAirCategoryOrder() {
  const hidden = document.querySelector('[name="airCategoryOrder"]');
  if (hidden) hidden.value = JSON.stringify(airCategoryOrder);
}

function renderAirCategoryOrder(items = []) {
  const container = document.getElementById('air-category-order-controls');
  if (!container) return;
  const categories = [...new Set(items.map((item) => item.category || 'Menu'))];
  airCategoryGroups = new Map(
    categories.map((category) => [
      category,
      items.some((item) => (item.category || 'Menu') === category && item.isBar) ? 'bar' : 'food',
    ])
  );
  airCategoryOrder = [
    ...airCategoryOrder.filter((category) => categories.includes(category)),
    ...categories.filter((category) => !airCategoryOrder.includes(category)),
  ];
  const food = airCategoryOrder.filter((category) => airCategoryGroups.get(category) !== 'bar');
  const bar = airCategoryOrder.filter((category) => airCategoryGroups.get(category) === 'bar');
  airCategoryOrder = [...food, ...bar];
  const group = (label, list) =>
    list.length
      ? `<div class="category-order-group"><b>${label}</b>${list
          .map((category) => {
            const index = airCategoryOrder.indexOf(category);
            return `<div class="category-control-row" data-category-order="${escapeHtml(category)}"><strong><span class="category-order-rank">${index + 1}</span>${escapeHtml(category)}</strong><span><button type="button" class="category-order-move" data-category-move="up" aria-label="Move ${escapeHtml(category)} up">↑</button><button type="button" class="category-order-move" data-category-move="down" aria-label="Move ${escapeHtml(category)} down">↓</button></span></div>`;
          })
          .join('')}</div>`
      : '';
  container.innerHTML = group('Food menu', food) + group('Alcohol & bar', bar);
  syncAirCategoryOrder();
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
  const barCategories = new Set(
    items.filter((item) => item.isBar).map((item) => item.category || 'Bar Menu')
  );
  categories.forEach((category) => {
    if (!airCategoryVisibility[category]) {
      airCategoryVisibility[category] = {
        table: true,
        card: !barCategories.has(category) && !isAlcoholCategory(category),
      };
    }
  });
  renderAirCategoryOptions(items);
  renderAirCategoryOrder(items);
  if (!container) return;
  container.innerHTML = categories.length
    ? categories
        .map((category) => {
          const setting = airCategoryVisibility[category];
          return `<div class="category-control-row" data-category="${escapeHtml(category)}">
      <strong>${escapeHtml(category)}</strong>
      <label><input type="checkbox" data-view="table" ${setting.table !== false ? 'checked' : ''}> Table QR</label>
      <label><input type="checkbox" data-view="card" ${setting.card !== false ? 'checked' : ''}> Business Card QR</label>
    </div>`;
        })
        .join('')
    : '<p class="air-empty">Add or import menu items to configure category visibility.</p>';
  syncAirCategoryVisibility();
}

function renderAirItems(items = []) {
  const container = document.getElementById('air-items-container');
  if (!container) return;
  container.innerHTML = items.map((item, index) => airItemMarkup(item, index)).join('');
  if (!items.length)
    container.innerHTML =
      '<tr class="air-empty-row"><td colspan="13"><p class="air-empty">Upload a CSV, paste from Excel, or add your first menu item.</p></td></tr>';
  updateAirSheetCounts();
  renderAirCategoryControls([...items, ...airBarSheetItems()]);
}

function airSheetItems() {
  return [...document.querySelectorAll('#air-items-container .air-item-entry')]
    .map((row) => {
      const category = row.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu';
      return {
        name: row.querySelector('[name="airItemName[]"]')?.value.trim() || '',
        price: row.querySelector('[name="airItemPrice[]"]')?.value.trim() || '',
        fullPrice: row.querySelector('[name="airItemFullPrice[]"]')?.value.trim() || '',
        halfPrice: row.querySelector('[name="airItemHalfPrice[]"]')?.value.trim() || '',
        withBonePrice: row.querySelector('[name="airItemWithBonePrice[]"]')?.value.trim() || '',
        bonelessPrice: row.querySelector('[name="airItemBonelessPrice[]"]')?.value.trim() || '',
        category,
        type:
          row.querySelector('[name="airItemType[]"]')?.value === 'beverage' ? 'beverage' : 'food',
        dietary:
          row.querySelector('[name="airItemDietary[]"]')?.value || dietaryFromAirCategory(category),
        description: row.querySelector('[name="airItemDescription[]"]')?.value.trim() || '',
        bestSeller: row.querySelector('[data-item-flag="bestSeller"]')?.checked || false,
        mustHave: row.querySelector('[data-item-flag="mustHave"]')?.checked || false,
        gravyStyleAvailable:
          row.querySelector('[data-item-flag="gravyStyleAvailable"]')?.checked || false,
      };
    })
    .filter((item) => item.name);
}

function airBarSheetItems() {
  return [...document.querySelectorAll('#air-bar-items-container .air-bar-item-entry')]
    .map((row) => ({
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
      isBar: true,
    }))
    .filter((item) => item.name);
}

function renderAirBarItems(items = []) {
  const container = document.getElementById('air-bar-items-container');
  if (!container) return;
  container.innerHTML = items.map((item, index) => airBarItemMarkup(item, index)).join('');
  if (!items.length)
    container.innerHTML =
      '<tr class="air-empty-row"><td colspan="11"><p class="air-empty">Upload a Bar Menu file, paste spreadsheet rows, or add the first bar item.</p></td></tr>';
  updateAirSheetCounts();
  renderAirCategoryControls([...airSheetItems(), ...items]);
}

function updateAirSheetCounts() {
  const count = (selector) =>
    [...document.querySelectorAll(selector)].filter((input) => input.value.trim()).length;
  const food = document.getElementById('air-food-sheet-count'),
    bar = document.getElementById('air-bar-sheet-count');
  if (food) {
    const total = count('[name="airItemName[]"]');
    food.textContent = `${total} item${total === 1 ? '' : 's'}`;
  }
  if (bar) {
    const total = count('[name="airBarItemName[]"]');
    bar.textContent = `${total} item${total === 1 ? '' : 's'}`;
  }
}
document.addEventListener('input', (event) => {
  if (event.target.matches('[name="airItemName[]"],[name="airBarItemName[]"]'))
    updateAirSheetCounts();
});

function dedupeAirSheetItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.category}::${item.name}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const addonUiStyles = document.createElement('style');
addonUiStyles.textContent = `#air-addon-management{border:1px solid #dce8f6;background:linear-gradient(145deg,#fff,#f7faff)}#air-addon-management .air-addon-group{margin:16px 0;padding:22px;border:1px solid #d9e5f2;border-radius:16px;background:#fff;box-shadow:0 8px 22px rgba(32,59,91,.045)}#air-addon-management .addon-group-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #edf1f6}#air-addon-management .addon-group-head b{display:block;color:#1d3150;font-size:17px}#air-addon-management .addon-group-head small{display:block;margin-top:3px;color:#71829a;font-size:12px}#air-addon-management .addon-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 22px}#air-addon-management .addon-fields .form-group{min-width:0;margin:0}#air-addon-management .addon-fields input,#air-addon-management .addon-fields select{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #cbd9e8;border-radius:9px;background:#fff;font:700 14px Manrope,Arial,sans-serif}#air-addon-management .addon-rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0;padding:15px;border-radius:12px;background:#f7faff}#air-addon-management .addon-rules .form-group{margin:0}#air-addon-management .addon-rules input,#air-addon-management .addon-rules select{box-sizing:border-box;width:100%;min-height:42px;border:1px solid #cbd9e8;border-radius:8px;background:#fff;font:700 14px Manrope,Arial,sans-serif}#air-addon-management .addon-rules .switch-row{grid-column:1/-1;min-height:42px;margin:0;padding:10px 12px;border:1px solid #dce6ef;border-radius:8px;background:#fff}#air-addon-management .addon-options{margin-top:14px;border:1px solid #dce6ef;border-radius:12px;overflow:hidden}#air-addon-management .addon-options-head{display:grid;grid-template-columns:minmax(0,2fr) 130px 135px 38px;gap:10px;padding:10px 14px;color:#667991;background:#f3f7fb;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}#air-addon-management .addon-option{display:grid;grid-template-columns:minmax(0,2fr) 130px 135px 38px;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid #edf1f5}#air-addon-management .addon-option input,#air-addon-management .addon-option select{box-sizing:border-box;width:100%;min-height:40px;padding:8px 10px;border:1px solid #cbd9e8;border-radius:8px;background:#fff;font:700 13px Manrope,Arial,sans-serif}#air-addon-management .addon-empty{padding:14px;color:#74859b;background:#fbfcfe;text-align:center;font-size:13px}#air-addon-management .addon-add-option,#add-air-addon-group{width:100%;margin-top:12px;padding:12px;border:1px dashed #9eb8d4;border-radius:9px;color:#24538a;background:#f8fbff;font-weight:900}#add-air-addon-group{margin-top:18px;color:#1a6550;border-color:#9ac9b6;background:#f4fcf7}@media(max-width:720px){#air-addon-management .addon-fields,#air-addon-management .addon-rules{grid-template-columns:1fr}#air-addon-management .addon-options-head{display:none}#air-addon-management .addon-option{grid-template-columns:1fr 1fr 38px}#air-addon-management .addon-option input:first-child{grid-column:1/-1}}`;
document.head.appendChild(addonUiStyles);
const addonUiOverride = document.createElement('style');
addonUiOverride.textContent = `#air-addon-management{max-width:none!important}#air-addon-management .addon-rules .switch-row{display:flex;align-items:center;justify-content:space-between}#air-addon-management .addon-rules .switch-row input{width:22px;min-height:22px;height:22px;margin-left:auto;accent-color:#df2c2c}`;
document.head.appendChild(addonUiOverride);
const addonUiPolish = document.createElement('style');
addonUiPolish.textContent = `#air-addon-management{padding:28px!important;border-radius:22px!important;box-shadow:0 14px 34px rgba(25,48,80,.06)}#air-addon-management .air-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:20px;border-bottom:1px solid #e8eef5}#air-addon-management .air-addon-group{position:relative;margin:20px 0;padding:24px;border-radius:18px;box-shadow:0 10px 26px rgba(32,59,91,.06)}#air-addon-management .addon-group-head{align-items:flex-start}#air-addon-management .addon-group-head b{margin-top:5px;font-size:19px;letter-spacing:-.02em}#air-addon-management .addon-group-state{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}#air-addon-management .addon-group-state.is-active{color:#176943;background:#eaf8ef}#air-addon-management .addon-group-state.is-inactive{color:#7b6570;background:#f8f0f2}#air-addon-management label>span{margin-left:5px;color:#8392a5;font-size:10px;font-weight:700;text-transform:none}#air-addon-management .addon-rules{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:18px;background:linear-gradient(135deg,#f5f8fd,#fafcff)}#air-addon-management .addon-rule-note{grid-column:1/-1;margin:0;color:#657b96;font-size:12px;font-weight:700}#air-addon-management .addon-rules .switch-row{min-height:54px;grid-column:1/-1;border-radius:10px}#air-addon-management .switch-row small{display:block;margin-top:4px;color:#73849a;font-size:11px;font-weight:650}#air-addon-management .addon-options-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:20px 0 8px}#air-addon-management .addon-options-title strong{color:#243852;font-size:16px}#air-addon-management .addon-options-title small{color:#71839b;font-size:12px;font-weight:700}#air-addon-management .addon-add-option,#add-air-addon-group{min-height:50px;border-radius:11px;transition:.18s ease}#air-addon-management .addon-add-option:hover,#add-air-addon-group:hover{transform:translateY(-1px);border-style:solid;background:#eef6ff}#add-air-addon-group:hover{background:#ecfbf4}@media(max-width:720px){#air-addon-management{padding:18px!important}#air-addon-management .air-addon-group{padding:16px}#air-addon-management .addon-rules{grid-template-columns:1fr!important}#air-addon-management .addon-options-title{align-items:flex-start;flex-direction:column;gap:3px}#air-addon-management .addon-option{padding:12px}#air-addon-management .addon-option .remove-air-item{align-self:end}}`;
document.head.appendChild(addonUiPolish);
let airAddonGroups = [];
function addonId() {
  return `addon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function normaliseAddonGroup(group = {}) {
  const selection = group.selection === 'multiple' ? 'multiple' : 'single',
    max = selection === 'single' ? 1 : Math.max(1, Math.min(20, Number(group.max) || 1)),
    min = Math.min(max, Math.max(0, Math.min(20, Number(group.min) || 0)));
  return {
    ...group,
    id: group.id || addonId(),
    name: String(group.name || '').slice(0, 80),
    displayName: String(group.displayName || '').slice(0, 100),
    selection,
    min,
    max,
    active: group.active !== false,
    options: Array.isArray(group.options) ? group.options : [],
  };
}
function addonGroupMarkup(rawGroup) {
  const group = normaliseAddonGroup(rawGroup),
    options = group.options;
  return `<article class="air-addon-group" data-addon-group="${escapeHtml(group.id)}"><div class="addon-group-head"><div><span class="addon-group-state ${group.active ? 'is-active' : 'is-inactive'}">${group.active ? 'Active' : 'Draft'}</span><b>${escapeHtml(group.name || 'New add-on group')}</b><small>Reusable choices. You can save the group now and attach it to dishes later.</small></div><button type="button" data-remove-addon-group="${escapeHtml(group.id)}" class="remove-air-item" aria-label="Remove add-on group">×</button></div><div class="addon-fields"><div class="form-group"><label>Group name <span>Internal</span></label><input data-addon-field="name" maxlength="80" value="${escapeHtml(group.name || '')}" placeholder="e.g. Extras"></div><div class="form-group"><label>Online display name <span>Guests see this</span></label><input data-addon-field="displayName" maxlength="100" value="${escapeHtml(group.displayName || '')}" placeholder="e.g. Choose your extras"></div></div><div class="addon-rules"><div class="form-group"><label>Minimum selections</label><input data-addon-field="min" type="number" min="0" max="20" value="${group.min}"></div><div class="form-group"><label>Maximum selections</label><input data-addon-field="max" type="number" min="1" max="20" value="${group.max}" ${group.selection === 'single' ? 'disabled' : ''}></div><div class="form-group"><label>Selection type</label><select data-addon-field="selection"><option value="single" ${group.selection === 'single' ? 'selected' : ''}>Choose one</option><option value="multiple" ${group.selection === 'multiple' ? 'selected' : ''}>Choose multiple</option></select></div><p class="addon-rule-note">${group.selection === 'single' ? 'Guests can choose up to one option.' : 'Guests can choose between the minimum and maximum.'}</p><label class="switch-row"><span><strong>Active</strong><small>Available to guests after this group is assigned to a dish.</small></span><input data-addon-field="active" type="checkbox" ${group.active ? 'checked' : ''}></label></div><div><div class="addon-options-title"><strong>Options</strong><small>${options.length ? `${options.length} choice${options.length === 1 ? '' : 's'} configured` : 'Add the choices guests can select.'}</small></div><div class="addon-options"><div class="addon-options-head"><span>Option name</span><span>Price</span><span>Dietary</span><span></span></div><div data-addon-options>${options.map((option, index) => `<div class="addon-option"><input data-addon-option="name" data-option-index="${index}" maxlength="80" value="${escapeHtml(option.name || '')}" placeholder="e.g. Extra cheese"><input data-addon-option="price" data-option-index="${index}" type="number" min="0" max="100000" step="0.01" value="${Number(option.price || 0)}" placeholder="0"><select data-addon-option="dietary" data-option-index="${index}"><option value="veg" ${option.dietary !== 'nonveg' ? 'selected' : ''}>Veg</option><option value="nonveg" ${option.dietary === 'nonveg' ? 'selected' : ''}>Non-Veg</option></select><button type="button" data-remove-addon-option="${index}" class="remove-air-item" aria-label="Remove option">×</button></div>`).join('') || '<p class="addon-empty">No options yet. This group can be saved as a draft, or add choices now.</p>'}</div></div><button type="button" data-add-addon-option class="addon-add-option">+ Add option</button></div></article>`;
}
function syncAirAddonGroups() {
  document.getElementById('air-addon-groups').value = JSON.stringify(airAddonGroups);
}
function renderAirAddonGroups(groups = airAddonGroups) {
  airAddonGroups = Array.isArray(groups) ? groups.map(normaliseAddonGroup) : [];
  const list = document.getElementById('air-addon-groups-list');
  if (!list) return;
  list.innerHTML =
    airAddonGroups.map(addonGroupMarkup).join('') ||
    '<p class="air-empty">No addon groups yet. Add groups such as Extras, Sauces, or Preparation choices.</p>';
  syncAirAddonGroups();
}
function readAirAddonGroup(element) {
  const id = element.dataset.addonGroup,
    index = airAddonGroups.findIndex((item) => item.id === id);
  if (index < 0) return;
  const current = airAddonGroups[index],
    selection =
      element.querySelector('[data-addon-field="selection"]')?.value === 'multiple'
        ? 'multiple'
        : 'single',
    rawMax = Number(element.querySelector('[data-addon-field="max"]')?.value) || 1;
  airAddonGroups[index] = normaliseAddonGroup({
    ...current,
    name: element.querySelector('[data-addon-field="name"]')?.value.trim() || '',
    displayName: element.querySelector('[data-addon-field="displayName"]')?.value.trim() || '',
    min: Number(element.querySelector('[data-addon-field="min"]')?.value) || 0,
    max: selection === 'single' ? 1 : rawMax,
    selection,
    active: !!element.querySelector('[data-addon-field="active"]')?.checked,
    options: [...element.querySelectorAll('[data-addon-option="name"]')]
      .map((input, optionIndex) => ({
        name: input.value.trim(),
        price: Math.max(
          0,
          Number(
            element.querySelector(`[data-addon-option="price"][data-option-index="${optionIndex}"]`)
              ?.value
          ) || 0
        ),
        dietary:
          element.querySelector(`[data-addon-option="dietary"][data-option-index="${optionIndex}"]`)
            ?.value === 'nonveg'
            ? 'nonveg'
            : 'veg',
      }))
      .filter((option) => option.name),
  });
  syncAirAddonGroups();
}
document.addEventListener('click', (event) => {
  const addGroup = event.target.closest('#add-air-addon-group');
  if (addGroup) {
    airAddonGroups.push({
      id: addonId(),
      name: '',
      displayName: '',
      min: 0,
      max: 1,
      selection: 'single',
      active: true,
      options: [],
    });
    renderAirAddonGroups();
    return;
  }
  const card = event.target.closest('[data-addon-group]');
  if (!card) return;
  readAirAddonGroup(card);
  const removeGroup = event.target.closest('[data-remove-addon-group]');
  if (removeGroup) {
    airAddonGroups = airAddonGroups.filter(
      (group) => group.id !== removeGroup.dataset.removeAddonGroup
    );
    renderAirAddonGroups();
    return;
  }
  if (event.target.closest('[data-add-addon-option]')) {
    const group = airAddonGroups.find((item) => item.id === card.dataset.addonGroup);
    group?.options.push({ name: '', price: 0, dietary: 'veg' });
    renderAirAddonGroups();
    return;
  }
  const removeOption = event.target.closest('[data-remove-addon-option]');
  if (removeOption) {
    const group = airAddonGroups.find((item) => item.id === card.dataset.addonGroup);
    if (group) group.options.splice(Number(removeOption.dataset.removeAddonOption), 1);
    renderAirAddonGroups();
  }
});
document.addEventListener('input', (event) => {
  const card = event.target.closest('[data-addon-group]');
  if (card) readAirAddonGroup(card);
});
document.addEventListener('change', (event) => {
  const card = event.target.closest('[data-addon-group]');
  if (!card) return;
  readAirAddonGroup(card);
  if (event.target.matches('[data-addon-field="selection"]')) renderAirAddonGroups();
});
document
  .querySelector('form[action="/api/update-airMenu"]')
  ?.addEventListener('submit', (event) => {
    document.querySelectorAll('[data-addon-group]').forEach(readAirAddonGroup);
    const form = event.currentTarget;
    const menuItemCount = [
      ...form.querySelectorAll('[name="airItemName[]"], [name="airBarItemName[]"]'),
    ].filter((input) => input.value.trim()).length;
    if (!menuItemCount) {
      const confirmed = window.confirm(
        'This will permanently clear every food and bar item from the live QR menu. A backup will be kept, but do you really want to continue?'
      );
      if (!confirmed) {
        event.preventDefault();
        return;
      }
      form.querySelector('[name="airMenuConfirmEmpty"]').value = 'on';
    }
    const incomplete = airAddonGroups.find((group) => !group.name.trim());
    if (!incomplete) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const card = [...document.querySelectorAll('[data-addon-group]')].find(
      (element) => element.dataset.addonGroup === incomplete.id
    );
    card?.querySelector('[data-addon-field="name"]')?.focus();
    alert('Give every add-on group a name, or remove the empty group before saving.');
  });

function fillAirMenu(menu = {}) {
  setField('airMenuTitle', menu.pageTitle);
  setField('airMenuSubtitle', menu.pageSubtitle);
  setField('airMenuNote', menu.note);
  renderAirAddonGroups(menu.addonGroups || []);
  setField('airSourceFileName', menu.sourceFileName);
  setField('airBarSourceFileName', menu.barSourceFileName);
  setField('airCardOrderPhone', menu.cardOrderPhone);
  setField('airTableQrDisabled', JSON.stringify(menu.tableQrDisabled || {}));
  setField('airProximityLatitude', menu.proximity?.latitude ?? '');
  setField('airProximityLongitude', menu.proximity?.longitude ?? '');
  const proximityLock = document.querySelector('[name="airProximityLocked"]');
  if (proximityLock) proximityLock.checked = menu.proximity?.locked === true;
  applyProximityLock(menu.proximity?.locked === true);
  setField('airTableProximityRadius', menu.proximity?.tableRadius ?? 0);
  setField('airCardProximityRadius', menu.proximity?.cardRadius ?? 0);
  setField('airLoyaltySpend', menu.loyalty?.spend || 10);
  setField('airLoyaltyEarn', menu.loyalty?.earn || 1);
  setField('airLoyaltyMinRedeem', menu.loyalty?.minRedeem || 100);
  setField('airLoyaltyPointValue', menu.loyalty?.pointValue || 1);
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
    airDeliveryEnabled: menu.deliveryEnabled !== false,
    airRestaurantClosed: menu.restaurantClosed === true,
    airLoyaltyEnabled: menu.loyalty?.enabled !== false,
  };
  Object.entries(toggles).forEach(([name, checked]) => {
    const field = document.querySelector(`[name="${name}"]`);
    if (field) field.checked = checked;
  });
  airCategoryVisibility =
    menu.categoryVisibility && typeof menu.categoryVisibility === 'object'
      ? { ...menu.categoryVisibility }
      : {};
  airCategoryOrder = Array.isArray(menu.categoryOrder)
    ? menu.categoryOrder.map((category) => String(category || '').trim()).filter(Boolean)
    : [];
  renderAirItems(Array.isArray(menu.items) ? menu.items : []);
  renderAirBarItems(Array.isArray(menu.barItems) ? menu.barItems : []);
}

const tableQrStyles = document.createElement('style');
tableQrStyles.textContent = `.table-qr-manager{margin-top:22px;padding:20px;border:1px solid #d9e5f2;border-radius:16px;background:#f8fbff}.table-qr-manager>div:first-child{display:grid;gap:4px}.table-qr-manager strong{color:#223b5c;font-size:16px}.table-qr-code-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin-top:16px}.table-qr-code{padding:14px;border:1px solid #dce6f0;border-radius:14px;background:#fff;text-align:center}.table-qr-code img{display:block;width:138px;height:138px;margin:8px auto;object-fit:contain}.table-qr-code b,.table-qr-code small{display:block}.table-qr-code b{color:#243852;font-size:14px}.table-qr-code small{margin:4px 0 10px;color:#71839b;font-size:11px}.table-qr-actions{display:flex;align-items:center;justify-content:center;gap:9px}.table-qr-actions a{padding:8px 10px;border-radius:8px;color:#175b9a;background:#eef6ff;font-size:11px;font-weight:800;text-decoration:none}.table-qr-toggle{display:inline-flex;align-items:center;gap:6px;color:#52677f;font-size:11px;font-weight:800}.table-qr-toggle input{appearance:none;width:38px;height:22px;margin:0;border-radius:999px;background:radial-gradient(circle at 11px 50%,#fff 0 8px,transparent 9px),#cbd5e1;cursor:pointer}.table-qr-toggle input:checked{background:radial-gradient(circle at 27px 50%,#fff 0 8px,transparent 9px),#c22635}`;
document.head.appendChild(tableQrStyles);

async function loadTableQrCodes() {
  const container = document.getElementById('table-qr-codes');
  if (!container) return;
  try {
    const response = await fetch('/api/admin/table-qr-codes', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load table QR codes.');
    container.innerHTML = data.codes?.length
      ? data.codes
          .map((code) => {
            const query = `area=${encodeURIComponent(code.areaId)}&table=${code.tableNumber}`;
            return `<article class="table-qr-code"><b>${escapeHtml(`${code.areaName} Table ${code.tableNumber}`)}</b><small>Permanent table menu QR</small><img src="/api/admin/qr/table?${query}" alt="${escapeHtml(`${code.areaName} Table ${code.tableNumber} QR code`)}"><div class="table-qr-actions"><a href="/api/admin/qr/table?${query}" download="red-lantern-table-${code.tableNumber}-qr.svg">Download</a><label class="table-qr-toggle"><input type="checkbox" data-table-qr-area="${escapeHtml(code.areaId)}" data-table-qr-number="${code.tableNumber}" ${code.enabled ? 'checked' : ''}>${code.enabled ? 'Live' : 'Disabled'}</label></div></article>`;
          })
          .join('')
      : '<p class="help-text">Add table areas in Orders → Operations → Table allocation. Their permanent QR codes will appear here automatically.</p>';
  } catch (error) {
    container.innerHTML = `<p class="help-text">${escapeHtml(error.message || 'Unable to load table QR codes.')}</p>`;
  }
}

document.addEventListener('change', async (event) => {
  const toggle = event.target.closest('[data-table-qr-area]');
  if (!toggle) return;
  toggle.disabled = true;
  try {
    const response = await fetch(`/api/admin/table-qr-codes/${encodeURIComponent(toggle.dataset.tableQrArea)}/${encodeURIComponent(toggle.dataset.tableQrNumber)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to update this QR code.');
    showSaveToast();
    await loadTableQrCodes();
  } catch (error) {
    toggle.checked = !toggle.checked;
    alert(error.message || 'Unable to update this QR code.');
  } finally { toggle.disabled = false; }
});

function setupAirMenuEditor() {
  const container = document.getElementById('air-items-container');
  const addButton = document.getElementById('add-air-item');
  const extractButton = document.getElementById('extract-air-menu');
  const categoryControls = document.getElementById('air-category-controls');
  if (!container) return;

  addButton?.addEventListener('click', () => {
    container.querySelector('.air-empty-row')?.remove();
    container.insertAdjacentHTML(
      'beforeend',
      airItemMarkup({}, container.querySelectorAll('.air-item-entry').length)
    );
    container.querySelector('.air-item-entry:last-child [name="airItemName[]"]')?.focus();
  });

  container.addEventListener('click', (event) => {
    if (!event.target.matches('.remove-air-item')) return;
    event.target.closest('.air-item-entry')?.remove();
    if (!container.querySelector('.air-item-entry')) renderAirItems([]);
    else
      renderAirCategoryControls(
        [...container.querySelectorAll('.air-item-entry')]
          .map((entry) => ({
            category: entry.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu',
          }))
          .concat(airBarSheetItems())
      );
  });

  container.addEventListener('input', (event) => {
    if (event.target.matches('[name="airItemCategory[]"]')) {
      syncDietaryPickerFromCategory(event.target.closest('.air-item-entry'));
      return;
    }
    const items = [...container.querySelectorAll('.air-item-entry')].map((entry) => ({
      category: entry.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu',
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
      if (dietary.checked)
        picker.querySelectorAll('[data-dietary]').forEach((choice) => {
          if (choice !== dietary) choice.checked = false;
        });
      if (hidden) hidden.value = dietary.checked ? dietary.dataset.dietary : '';
      const row = dietary.closest('.air-item-entry');
      const status = document.getElementById('air-sheet-status');
      const payload = {
        name: row?.querySelector('[name="airItemName[]"]')?.value.trim() || '',
        category: row?.querySelector('[name="airItemCategory[]"]')?.value.trim() || 'Menu',
        dietary: hidden?.value || '',
      };
      if (status) {
        status.textContent = 'Saving dietary selection…';
        status.style.color = '#6b7280';
      }
      try {
        const response = await fetch('/api/admin/air-menu/dietary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to save selection.');
        if (status) {
          status.textContent = `${payload.name}: ${payload.dietary === 'nonveg' ? 'Non-Veg' : payload.dietary === 'veg' ? 'Veg' : 'dietary selection cleared'} saved live.`;
          status.style.color = '#166534';
        }
      } catch (error) {
        if (status) {
          status.textContent = error.message;
          status.style.color = '#b91c1c';
        }
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
      gravyStyleAvailable: flag.checked,
    };
    if (status) {
      status.textContent = 'Saving Gravy / Semi-Gravy setting…';
      status.style.color = '#6b7280';
    }
    try {
      const response = await fetch('/api/admin/air-menu/gravy-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save setting.');
      if (status) {
        status.textContent = `${payload.name}: Gravy / Semi-Gravy ${payload.gravyStyleAvailable ? 'enabled' : 'disabled'} and saved live.`;
        status.style.color = '#166534';
      }
    } catch (error) {
      if (status) {
        status.textContent = error.message;
        status.style.color = '#b91c1c';
      }
    }
  });

  container.addEventListener('paste', (event) => {
    const target = event.target.closest('input, select');
    const clipboard = event.clipboardData?.getData('text/plain') || '';
    if (!target || (!clipboard.includes('\t') && !clipboard.includes('\n'))) return;
    event.preventDefault();
    const pastedRows = clipboard
      .replace(/\r/g, '')
      .split('\n')
      .filter((row) => row.trim())
      .map((row) => row.split('\t'));
    const fields = [
      'bestSeller',
      'mustHave',
      'gravyStyleAvailable',
      'airItemName[]',
      'airItemPrice[]',
      'airItemFullPrice[]',
      'airItemHalfPrice[]',
      'airItemWithBonePrice[]',
      'airItemBonelessPrice[]',
      'airItemCategory[]',
      'airItemType[]',
      'dietary',
      'airItemDescription[]',
    ];
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
          const dietaryValue = /non[\s-]?veg/i.test(value)
            ? 'nonveg'
            : /veg/i.test(value)
              ? 'veg'
              : '';
          const checkbox = row.querySelector(`[data-dietary="${dietaryValue}"]`);
          if (checkbox) {
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return;
        }
        if (['bestSeller', 'mustHave', 'gravyStyleAvailable'].includes(fieldName)) {
          const checkbox = row.querySelector(`[data-item-flag="${fieldName}"]`);
          const checked =
            /^(1|true|yes|y|checked|best seller|must have|must try|popular|gravy|semi[-\s]?gravy)$/i.test(
              value.trim()
            );
          if (checkbox) {
            checkbox.checked = checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return;
        }
        const field = row.querySelector(`[name="${fieldName}"]`);
        if (!field) return;
        const cleanValue = value.trim();
        field.value =
          fieldName === 'airItemType[]'
            ? /beverage|drink/i.test(cleanValue)
              ? 'beverage'
              : 'food'
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

  document.getElementById('air-category-order-controls')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category-move]');
    if (!button) return;
    const category = button.closest('[data-category-order]')?.dataset.categoryOrder;
    const group = airCategoryGroups.get(category) || 'food';
    const groupCategories = airCategoryOrder.filter(
      (item) => (airCategoryGroups.get(item) || 'food') === group
    );
    const index = groupCategories.indexOf(category);
    const direction = button.dataset.categoryMove === 'up' ? -1 : 1;
    const next = index + direction;
    if (index < 0 || next < 0 || next >= groupCategories.length) return;
    [groupCategories[index], groupCategories[next]] = [
      groupCategories[next],
      groupCategories[index],
    ];
    const food =
      group === 'food'
        ? groupCategories
        : airCategoryOrder.filter((item) => (airCategoryGroups.get(item) || 'food') === 'food');
    const bar =
      group === 'bar'
        ? groupCategories
        : airCategoryOrder.filter((item) => airCategoryGroups.get(item) === 'bar');
    airCategoryOrder = [...food, ...bar];
    renderAirCategoryOrder(
      airCategoryOrder.map((item) => ({
        category: item,
        isBar: airCategoryGroups.get(item) === 'bar',
      }))
    );
  });

  extractButton?.addEventListener('click', async () => {
    const fileInput = document.getElementById('air-menu-file');
    const status = document.getElementById('air-extract-status');
    const file = fileInput?.files?.[0];
    if (!file) {
      status.textContent = 'Choose a PDF, CSV, or XLSX file first.';
      status.style.color = '#b91c1c';
      return;
    }
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
      const importedCategories = new Set(
        importedItems.map((item) => cleanAirSheetText(item.category || 'Menu', true).toLowerCase())
      );
      const preservedItems = airSheetItems().filter(
        (item) => !importedCategories.has(cleanAirSheetText(item.category, true).toLowerCase())
      );
      renderAirItems(dedupeAirSheetItems([...preservedItems, ...importedItems]));
      setField('airSourceFileName', result.fileName || file.name);
      const method =
        result.extractionMethod === 'ocr'
          ? 'local OCR'
          : result.extractionMethod === 'csv'
            ? 'CSV columns'
            : result.extractionMethod === 'xlsx'
              ? 'XLSX columns'
              : 'embedded PDF text';
      const sourceDetail = /^(csv|xlsx)$/.test(result.extractionMethod)
        ? ''
        : ` from ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}`;
      status.textContent =
        result.warning ||
        `Updated ${importedCategories.size} categor${importedCategories.size === 1 ? 'y' : 'ies'} with ${importedItems.length} unique items${sourceDetail} using ${method}. Other categories were preserved.`;
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

  const refreshCategories = () =>
    renderAirCategoryControls([...airSheetItems(), ...airBarSheetItems()]);
  addButton?.addEventListener('click', () => {
    container.querySelector('.air-empty-row')?.remove();
    container.insertAdjacentHTML(
      'beforeend',
      airBarItemMarkup({}, container.querySelectorAll('.air-bar-item-entry').length)
    );
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
    const pastedRows = clipboard
      .replace(/\r/g, '')
      .split('\n')
      .filter((row) => row.trim())
      .map((row) => row.split('\t'));
    const fields = [
      'airBarItemName[]',
      'airBarItemPrice[]',
      'airBarItem30mlPrice[]',
      'airBarItem60mlPrice[]',
      'airBarItem90mlPrice[]',
      'airBarItem180mlPrice[]',
      'airBarItemCategory[]',
      'airBarItemType[]',
      'airBarItemDescription[]',
      'bestSeller',
    ];
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
        field.value =
          fieldName === 'airBarItemType[]'
            ? /food/i.test(value)
              ? 'food'
              : 'beverage'
            : value.trim();
      });
    });
    renderAirBarItems(dedupeAirSheetItems(airBarSheetItems()));
  });

  extractButton?.addEventListener('click', async () => {
    const fileInput = document.getElementById('air-bar-menu-file');
    const status = document.getElementById('air-bar-extract-status');
    const file = fileInput?.files?.[0];
    if (!file) {
      status.textContent = 'Choose a Bar Menu PDF, CSV, or XLSX file first.';
      status.style.color = '#b91c1c';
      return;
    }
    extractButton.disabled = true;
    status.textContent = /\.(csv|xlsx)$/i.test(file.name)
      ? 'Reading Bar Menu spreadsheet…'
      : 'Scanning the Bar Menu PDF with local OCR…';
    status.style.color = '#6b7280';
    try {
      const data = new FormData();
      data.append('menuFile', file);
      const response = await fetch('/api/admin/air-menu/extract-bar', {
        method: 'POST',
        body: data,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Bar Menu extraction failed.');
      const importedItems = dedupeAirSheetItems(result.items || []);
      const importedCategories = new Set(
        importedItems.map((item) =>
          cleanAirSheetText(item.category || 'Bar Menu', true).toLowerCase()
        )
      );
      const preservedItems = airBarSheetItems().filter(
        (item) => !importedCategories.has(cleanAirSheetText(item.category, true).toLowerCase())
      );
      renderAirBarItems(dedupeAirSheetItems([...preservedItems, ...importedItems]));
      setField('airBarSourceFileName', result.fileName || file.name);
      const method =
        result.extractionMethod === 'ocr'
          ? 'local OCR'
          : result.extractionMethod === 'xlsx'
            ? 'XLSX columns'
            : result.extractionMethod === 'csv'
              ? 'CSV columns'
              : 'embedded PDF text';
      status.textContent =
        result.warning ||
        `Updated ${importedCategories.size} bar categor${importedCategories.size === 1 ? 'y' : 'ies'} with ${importedItems.length} unique items using ${method}. Other bar categories were preserved.`;
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
    blogsContainer.innerHTML = blogs.posts
      .map((post, index) => blogEntryMarkup(post, index))
      .join('');
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
  const fileInputs = [...form.querySelectorAll('input[type="file"]')].filter(
    (input) => input.files && input.files.length > 0
  );

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
  container.innerHTML = items
    .map(
      (item) => `
    <div class="growth-item">
      <strong>${item.title}</strong>
      <span>${item.detail}</span>
      ${item.tag ? `<div class="growth-tag">${item.tag}</div>` : ''}
    </div>
  `
    )
    .join('');
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const renderAiItems = (id, items, mapper) => {
  const container = document.getElementById(id);
  if (!container) return;
  container.innerHTML = (items || [])
    .map((item) => {
      const mapped = mapper(item);
      return `
      <div class="growth-item">
        <strong>${escapeHtml(mapped.title)}</strong>
        <span>${escapeHtml(mapped.detail)}</span>
        ${mapped.tag ? `<div class="growth-tag">${escapeHtml(mapped.tag)}</div>` : ''}
      </div>
    `;
    })
    .join('');
};

function renderAiGrowthPlan(plan) {
  const results = document.getElementById('growth-ai-results');
  const summary = document.getElementById('growth-ai-summary');
  if (results) results.style.display = 'block';
  if (summary) summary.textContent = plan.summary || '';

  renderAiItems('growth-ai-trends', plan.trendSignals, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.priority,
  }));

  renderAiItems('growth-ai-actions', plan.priorityActions, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.impact,
  }));

  renderAiItems('growth-ai-seo', plan.seoWinningMoves, (item) => ({
    title: item.title,
    detail: item.detail,
    tag: item.searchTarget,
  }));

  renderAiItems('growth-ai-content', plan.contentIdeas, (item) => ({
    title: item.title,
    detail: `${item.searchIntent} ${item.outline} Keywords: ${(item.keywords || []).join(', ')}`,
    tag: 'Content',
  }));

  renderAiItems('growth-ai-ads', plan.adIdeas, (item) => ({
    title: item.campaign,
    detail: `${item.audience} ${item.message} Landing page: ${item.landingPage}`,
    tag: 'Ads',
  }));

  renderAiItems('growth-ai-missing', plan.missingWebsiteItems, (item) => ({
    title: item,
    detail: 'Add or improve this to strengthen local SEO and conversion.',
    tag: 'Missing',
  }));

  const sources = document.getElementById('growth-ai-sources');
  if (sources) {
    sources.innerHTML = (plan.sources || [])
      .map(
        (source) => `
      <div class="growth-item">
        <strong>${escapeHtml(source.title)}</strong>
        <a class="growth-source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a>
      </div>
    `
      )
      .join('');
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
  const hasLocalSeo =
    contact.address && contact.phone && contact.mapEmbedUrl && global.googleBusinessUrl;
  const hasBlogEngine = posts.length >= 3;
  const hasMenuDepth = dishes.length >= 8;
  const hasOrdering = global.zomatoUrl && global.swiggyUrl;
  const hasSeoBasics =
    global.siteUrl && global.seoTitle && global.seoDescription && global.seoKeywords;
  const targetLocations = String(global.targetLocations || 'Colva, South Goa')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const targetCuisines = String(global.targetCuisines || 'Chinese food, Goan seafood')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const competitors = String(global.competitorNames || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const score = [
    hasAds,
    hasLocalSeo,
    hasBlogEngine,
    hasMenuDepth,
    hasOrdering,
    hasSeoBasics,
  ].filter(Boolean).length;

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
    scoreLabel.textContent =
      score === 6
        ? '✅ Green signal: all core readiness items are complete. Well done!'
        : 'Use Refresh progress after saving content changes to update the readiness score.';
  }

  const actions = [
    !hasLocalSeo && {
      title: 'Finish local SEO fields (Contact & Global Settings)',
      detail:
        'Go to the "Contact Page" tab and add your exact Address, Phone, and Google Map Embed URL. Then go to "Footer & Settings" > "SEO Defaults" and add your Google Business Profile URL. These are critical for ranking on Google Maps in Colva.',
      tag: 'High impact',
    },
    !hasMenuDepth && {
      title: 'Expand the dynamic menu (Menu Page)',
      detail:
        'Go to the "Menu Page" tab and add at least 8-12 signature dishes. Be sure to use categories (e.g., "Goan Seafood") and write descriptions with keywords to help Google understand what you serve.',
      tag: 'SEO content',
    },
    !hasBlogEngine && {
      title: 'Publish more local food blogs (Blogs Page)',
      detail:
        'Go to the "Blogs Page" tab and publish at least 3-6 posts. Use the blog ideas below. For example, write about "Best Chinese Food in Colva" using H2 tags for keywords and include original photos.',
      tag: 'Visibility',
    },
    !hasAds && {
      title: 'Add ad tracking before spending (Footer & Settings)',
      detail:
        'Go to the "Footer & Settings" tab > "Ads & Tracking" and paste your GA4, Google Ads, and Meta Pixel IDs. Do this before running any ads so you can track calls, menu views, and orders.',
      tag: 'Before ads',
    },
    !hasOrdering && {
      title: 'Add real Zomato and Swiggy links (Footer & Settings)',
      detail:
        'Go to "Footer & Settings" > "Footer Content" and add your exact Zomato and Swiggy URLs. This turns website visitors into paying customers immediately.',
      tag: 'Conversion',
    },
    {
      title: 'Compare your offer against nearby competitors',
      detail: competitors.length
        ? `You listed: ${competitors.slice(0, 4).join(', ')}. Go to the "Menu" and "About" pages to ensure your photos, prices, and story look more appealing than theirs.`
        : 'Go to "Footer & Settings" > "Market Research Inputs". Add competitor names so we can suggest targeted content to beat them.',
      tag: 'Competition',
    },
    {
      title: `Plan content for ${season}`,
      detail:
        season === 'monsoon season'
          ? 'Update your "Home Page" hero subtitle and "Blogs Page" to push cozy indoor dining, hot soups, and delivery options.'
          : 'Update your "Home Page" hero and "Blogs" to push tourist-friendly searches, seafood, and late-night dinners near Colva Beach.',
      tag: 'Seasonal',
    },
  ].filter(Boolean);

  if (actions.length <= 2 && score === 6) {
    // Only Competitor/Seasonal are left
    actions.unshift({
      title: '✅ 100% SEO Foundation Ready! (Green Signal)',
      detail:
        'Amazing work! Your website has strong foundational SEO, rich menus, full tracking, and contact details. Now focus on publishing more blogs and running targeted ads based on the ideas below.',
      tag: 'All Good!',
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
      tag: 'Local Pack',
    },
    {
      title: 'Build one page for each money search',
      detail: `Create focused website sections or landing pages for searches like "${primaryCuisine} in ${primaryLocation}", "${secondaryCuisine} near ${primaryLocation}", "family restaurant in ${secondaryLocation}", and "restaurants near Colva Beach". Each page needs unique text, photos, menu links, map, phone, and ordering buttons.`,
      tag: 'Pages',
    },
    {
      title: 'Turn the menu into SEO content',
      detail: hasMenuDepth
        ? 'You have enough menu depth to start ranking pages around individual dishes. Add prices, original photos, descriptions, spice level, cuisine category, and internal links from blogs to each signature dish.'
        : 'Add at least 8-12 dishes with categories, descriptions, and original photos. Google needs clear menu content to understand what food searches Red Lantern should rank for.',
      tag: 'Menu SEO',
    },
    {
      title: 'Publish blog clusters, not random posts',
      detail: hasBlogEngine
        ? `You have ${posts.length} blog post(s). Next, create clusters around Colva restaurants, Chinese food, Goan seafood, family dining, delivery/order searches, and tourist food guides. Link every post back to Menu and Contact.`
        : 'Publish at least 3 starter posts: best Chinese food in Colva, Goan seafood near Colva Beach, and family restaurant in South Goa. Then expand each topic into related posts.',
      tag: 'Content',
    },
    {
      title: 'Beat competitors with comparison intent',
      detail: competitors.length
        ? `You are tracking ${competitors.slice(0, 4).join(', ')}. Create comparison-style content that highlights Red Lantern strengths: cuisine range, ambience, location, value, delivery links, photos, and signature dishes. Keep the tone factual, not negative.`
        : 'Add competitor names in Market Research Inputs. The AI scanner can then generate comparison topics and ad angles against restaurants people already search for.',
      tag: 'Competitors',
    },
    {
      title: 'Improve trust signals everywhere',
      detail:
        'Add real customer reviews, restaurant photos, chef/story details, exact address, phone, map, opening hours, order links, and social profiles. These help both Google and visitors trust the business.',
      tag: 'Trust',
    },
    {
      title: 'Track what is working',
      detail: hasAds
        ? 'Tracking is partly configured. Use GA4/Search Console/Google Business Profile insights to watch calls, directions, menu clicks, order clicks, and the searches people use to find you.'
        : 'Add GA4, Google Search Console, Google Business Profile insights, and ad conversion tracking before serious ad spend. Ranking work needs measurement.',
      tag: 'Tracking',
    },
  ];

  const blogIdeas = [
    {
      title: `Best ${primaryCuisine} in ${primaryLocation}: What to Order at Red Lantern`,
      detail: `Go to "Blogs Page" tab. Feature ${dishNames.slice(0, 3).join(', ') || 'your top dishes'} with photos, prices, reviews, and why guests love them. Link to your Menu page.`,
      tag: 'Blog',
    },
    {
      title: `${secondaryCuisine} Restaurant Near ${primaryLocation}: A Local Guide`,
      detail: `Go to "Blogs Page" tab. Target tourists searching around ${primaryLocation}. Include distance, ambience, opening hours, fish/prawn dishes, and embed your Google Map.`,
      tag: 'Local SEO',
    },
    {
      title: `Family Restaurant in ${secondaryLocation}: Why Red Lantern Works for Groups`,
      detail:
        'Go to "Blogs Page" tab. Write about seating, budget-friendly dishes, kids/family choices, order online options, and dinner timing. Link to your Contact page.',
      tag: 'Commercial',
    },
    {
      title: `${secondaryLocation} Food Guide: ${targetCuisines.slice(0, 3).join(', ') || 'Chinese, Goan seafood, and comfort food'}`,
      detail:
        'Go to "Blogs Page" tab. Create a broad guide that can rank for tourists planning where to eat in Goa before they arrive.',
      tag: 'Tourist search',
    },
    {
      title: `${primaryLocation} Restaurant Comparison: What Makes Red Lantern Different`,
      detail: competitors.length
        ? `Go to "Blogs Page" tab. Compare your strengths against ${competitors.slice(0, 3).join(', ')} without attacking them: cuisine variety, ambience, prices, order links, photos, and location.`
        : 'Go to "Footer & Settings" > "Market Research Inputs" to add competitors. Then write a blog comparing your restaurant to them.',
      tag: 'Competitive',
    },
    {
      title: `${season.charAt(0).toUpperCase() + season.slice(1)} Food Picks in Goa`,
      detail:
        'Go to "Blogs Page" tab. Tie current season to practical menu recommendations, photos, and calls to action for directions and orders.',
      tag: 'Seasonal',
    },
  ];

  const adIdeas = [
    {
      title: `Google Search Campaign: “restaurants near ${primaryLocation}”`,
      detail:
        'Create a Google Ad sending traffic to your Home or Contact page. Make sure "Footer & Settings" has tracking IDs and conversion labels set up first.',
      tag: 'High intent',
    },
    {
      title: `Google Search Campaign: “best ${primaryCuisine} in ${primaryLocation}”`,
      detail: `Create a Google Ad sending traffic directly to your Menu page. Focus keywords on ${primaryCuisine}.`,
      tag: 'Keyword',
    },
    {
      title: 'Instagram Campaign: food photos + directions',
      detail:
        'Create a Meta/Instagram Ad using your best dish photos. Set the Call-To-Action to "Get Directions" or "Order Now". Ensure Meta Pixel ID is saved in "Footer & Settings".',
      tag: 'Awareness',
    },
    {
      title: 'Tourist campaign before arrival',
      detail:
        'Target Google/Meta ads to people interested in Goa travel, Colva, South Goa hotels, beaches, seafood, and family restaurants.',
      tag: 'Future',
    },
    {
      title: 'Competitor defense campaign',
      detail: competitors.length
        ? `Create Google Ads targeting people searching for ${competitors.slice(0, 3).join(', ')}. Highlight your better prices or ambience.`
        : 'Go to "Footer & Settings" and add competitors first to get specific ad targets here.',
      tag: 'Competitive',
    },
  ];

  const checklist = [
    [
      'Google Business Profile linked',
      Boolean(global.googleBusinessUrl),
      'Go to "Footer & Settings" > "SEO Defaults" > Add "Google Business Profile URL"',
    ],
    [
      'GA4 / Google Ads / Meta Pixel added',
      Boolean(hasAds),
      'Go to "Footer & Settings" > "Ads & Tracking" > Add at least one Tracking ID',
    ],
    [
      'Real Zomato and Swiggy URLs added',
      Boolean(hasOrdering),
      'Go to "Footer & Settings" > "Footer Content" > Add both Order Links',
    ],
    [
      'At least 8 menu items added',
      Boolean(hasMenuDepth),
      'Go to "Menu Page" > Add 8+ dishes with photos and descriptions',
    ],
    [
      'At least 3 blogs published',
      Boolean(hasBlogEngine),
      'Go to "Blogs Page" > Publish 3+ SEO-optimized articles',
    ],
    [
      'SEO title, description, keywords, and site URL saved',
      Boolean(hasSeoBasics),
      'Go to "Footer & Settings" > "SEO Defaults" > Fill all 4 SEO fields',
    ],
    [
      'Map embed, address, phone, and hours saved',
      Boolean(contact.mapEmbedUrl && contact.address && contact.phone && contact.hours),
      'Go to "Contact Page" > Fill out Contact Details and Google Map Embed',
    ],
    [
      'Competitors, target locations, and target searches saved',
      Boolean(competitors.length && targetLocations.length && targetCuisines.length),
      'Go to "Footer & Settings" > "Market Research Inputs" > Fill all 3 fields',
    ],
  ].map(([title, done, instruction]) => ({
    title: `${done ? '✅ Done' : '❌ Needed'}: ${title}`,
    detail: done ? 'This part is ready.' : `ACTION: ${instruction}`,
    tag: done ? 'Ready' : 'Missing',
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
    loadTableQrCodes();
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
let ordersErrorLogs = [];
const selectedLogIds = new Set();

function formatLogTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
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
  const details =
    log.details && Object.keys(log.details).length ? JSON.stringify(log.details, null, 2) : '';

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
    details ? `Details:\n${details}` : '',
  ]
    .filter(Boolean)
    .join('\n');
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
      stack: error.stack || '',
    });
  }
}

function renderHealth(data = {}) {
  const grid = document.getElementById('health-grid');
  const status = document.getElementById('health-status');
  if (!grid) return;
  const checks = data.checks || {};
  const entries = Object.entries(checks);
  grid.innerHTML = entries.length
    ? entries
        .map(
          ([name, check]) => `
    <div class="health-item ${check.ok ? 'ok' : 'bad'}">
      <strong>${check.ok ? 'Ready' : 'Needs attention'}: ${escapeHtml(name)}</strong>
      <span>${escapeHtml(check.message || '')}</span>
    </div>
  `
        )
        .join('')
    : '<p class="log-status">No health data available.</p>';
  if (status)
    status.textContent = data.checkedAt
      ? `${data.ok ? 'Healthy' : 'Needs attention'} · ${formatLogTime(data.checkedAt)}`
      : 'Health check unavailable.';
  renderDatabaseHealth(data.databaseMetrics);
}

function formatDatabaseBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderDatabaseHealth(metrics) {
  const summary = document.getElementById('database-health-summary');
  const details = document.getElementById('database-health-details');
  if (!summary || !details) return;
  if (!metrics) {
    summary.innerHTML =
      '<div class="database-metric warning"><strong>Unavailable</strong><span>Connect Neon to show database health.</span></div>';
    details.innerHTML = '';
    return;
  }
  const storageClass = metrics.storageWarning ? ' warning' : '';
  summary.innerHTML = `
    <div class="database-metric"><strong>${escapeHtml(String(metrics.latencyMs || 0))} ms</strong><span>Database response time</span></div>
    <div class="database-metric${storageClass}"><strong>${escapeHtml(formatDatabaseBytes(metrics.sizeBytes))}</strong><span>${metrics.storageWarning ? 'Storage warning threshold reached' : 'Current database storage'}</span></div>
    <div class="database-metric"><strong>${metrics.latestOrderAt ? escapeHtml(formatLogTime(metrics.latestOrderAt)) : 'No orders yet'}</strong><span>Latest saved order</span></div>`;
  const counts = metrics.counts || {};
  const entries = [
    ['Orders', counts.orders],
    ['KOTs', counts.kots],
    ['Printer configurations', counts.printerConfigs],
    ['Currently unavailable items', counts.unavailableItems],
    ['Loyalty accounts', counts.loyaltyAccounts],
    ['Alert devices', counts.alertDevices],
  ];
  details.innerHTML = entries
    .map(
      ([label, value]) =>
        `<div class="health-item ok"><strong>${escapeHtml(String(Number(value || 0).toLocaleString('en-IN')))}</strong><span>${escapeHtml(label)}</span></div>`
    )
    .join('');
}

async function refreshHealth() {
  if (refreshHealth.inFlight) return;
  refreshHealth.inFlight = true;
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
      stack: error.stack || '',
    });
  } finally {
    refreshHealth.inFlight = false;
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

  list.innerHTML = logs
    .map((log) => {
      const details =
        log.details && Object.keys(log.details).length ? JSON.stringify(log.details, null, 2) : '';
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
    })
    .join('');
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
      stack: error.stack || '',
    });
  }
}

function renderOrdersErrorLogs() {
  const list = document.getElementById('orders-errors-list');
  const status = document.getElementById('orders-errors-status');
  if (!list) return;
  if (status)
    status.textContent = `${ordersErrorLogs.length} Orders issue${ordersErrorLogs.length === 1 ? '' : 's'} loaded`;
  if (!ordersErrorLogs.length) {
    list.innerHTML =
      '<p class="log-status">No Orders errors recorded. Everything is running normally.</p>';
    return;
  }
  list.innerHTML = ordersErrorLogs
    .map((log) => {
      const details =
        log.details && Object.keys(log.details).length ? JSON.stringify(log.details, null, 2) : '';
      return `<article class="log-entry ${escapeHtml(log.level || 'error')}">
      <div class="log-entry-header"><h3>${escapeHtml(log.message || 'Orders issue')}</h3><span class="log-badge ${escapeHtml(log.level || 'error')}">${escapeHtml(log.level || 'error')}</span></div>
      <div class="log-meta"><span><strong>When:</strong> ${escapeHtml(formatLogTime(log.created_at))}</span><span><strong>Area:</strong> ${escapeHtml(log.location || log.path || 'Orders console')}</span><span><strong>Route:</strong> ${escapeHtml(logRoute(log))}</span><span><strong>Status:</strong> ${escapeHtml(log.status_code || 'Browser/device')}</span><span><strong>Load time:</strong> ${log.duration_ms ? `${escapeHtml(log.duration_ms)}ms` : '—'}</span></div>
      <div class="log-solution"><strong>How to resolve:</strong> ${escapeHtml(log.solution || 'Review the event details and retry the affected action.')}</div>
      ${details ? `<pre class="log-details">${escapeHtml(details)}</pre>` : ''}
    </article>`;
    })
    .join('');
}

async function refreshOrdersErrorLogs() {
  const status = document.getElementById('orders-errors-status');
  if (status) status.textContent = 'Loading Orders errors...';
  try {
    const response = await fetch('/api/admin/orders-errors?limit=100', { cache: 'no-store' });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        response.status === 404
          ? 'This server has not received the Orders Error Logs update yet. Restart or deploy the latest code.'
          : `Orders Error Logs service returned ${response.status}. Please check the admin login and server deployment.`
      );
    }
    if (!response.ok) throw new Error(data.error || 'Unable to load Orders error logs.');
    ordersErrorLogs = data.logs || [];
    renderOrdersErrorLogs();
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to load Orders error logs.';
  }
}

async function clearOrdersErrorLogs() {
  if (!window.confirm('Clear all Orders error logs?')) return;
  const status = document.getElementById('orders-errors-status');
  if (status) status.textContent = 'Clearing Orders errors...';
  try {
    const response = await fetch('/api/admin/orders-errors', { method: 'DELETE' });
    if (!response.ok) throw new Error('Unable to clear Orders error logs.');
    await refreshOrdersErrorLogs();
  } catch (error) {
    if (status) status.textContent = error.message || 'Unable to clear Orders error logs.';
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
    ['Business Card QR', summary.card_scans || 0],
  ];
  stats.innerHTML = statItems
    .map(
      ([label, value]) =>
        `<div class="scan-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`
    )
    .join('');
  const scans = data.scans || [];
  if (status)
    status.textContent = `${scans.length} recent scan${scans.length === 1 ? '' : 's'} loaded`;
  list.innerHTML = scans.length
    ? scans
        .map((scan) => {
          const details = scan.details || {};
          const place =
            [details.city, details.region, details.country].filter(Boolean).join(', ') ||
            'Approximate location unavailable';
          return `<article class="scan-entry">
      <div><strong>${escapeHtml(details.qrType || scan.message || 'QR scan')}</strong><span>${escapeHtml(formatLogTime(scan.created_at))}</span></div>
      <div><strong>${details.mode === 'card' ? 'Visiting-card menu' : 'In-store table menu'}</strong><span>Anonymous visitor: ${escapeHtml(scan.ip_hash || 'unavailable')} · ${escapeHtml(scan.visitor_scan_count || 1)} scan${Number(scan.visitor_scan_count || 1) === 1 ? '' : 's'}</span></div>
      <div><strong>${escapeHtml(place)}</strong><span>Approximate network location</span></div>
    </article>`;
        })
        .join('')
    : '<p class="log-status">No QR scans have been recorded yet.</p>';
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
  document
    .getElementById('refresh-orders-errors')
    ?.addEventListener('click', refreshOrdersErrorLogs);
  document.getElementById('clear-orders-errors')?.addEventListener('click', clearOrdersErrorLogs);
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
  refreshOrdersErrorLogs();
  document
    .querySelector('[data-target="tab-database-health"]')
    ?.addEventListener('click', refreshHealth);
  document
    .querySelector('[data-target="tab-orders-errors"]')
    ?.addEventListener('click', refreshOrdersErrorLogs);
  window.setInterval(() => {
    if (
      document.visibilityState === 'visible' &&
      document.getElementById('tab-database-health')?.classList.contains('active')
    )
      refreshHealth();
  }, 30000);
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

function setupCustomerInsights() {
  const date = document.getElementById('insight-date');
  const search = document.getElementById('insight-search');
  const refresh = document.getElementById('refresh-customer-insights');
  const printSummary = document.getElementById('print-register-summary');
  const stats = document.getElementById('customer-insight-stats');
  const rows = document.getElementById('customer-insight-orders');
  const leaderboard = document.getElementById('customer-insight-leaderboard');
  const status = document.getElementById('customer-insight-status');
  if (!date || !rows) return;
  const decorateInsightPills = () =>
    rows.querySelectorAll('tr').forEach((row) => {
      const cells = row.children;
      const points = cells[5]?.querySelector('.insight-pill');
      const credit = cells[6]?.querySelector('.insight-pill');
      const orderStatus = cells[7]?.querySelector('.insight-pill');
      if (points) {
        const value = Number.parseInt(points.textContent, 10) || 0;
        points.classList.add('points');
        points.classList.toggle('is-empty', value <= 0);
      }
      if (credit) {
        const value = Number(String(credit.textContent).replace(/[^0-9.-]/g, '')) || 0;
        credit.classList.remove('credit');
        credit.classList.add(value > 0 ? 'credit-due' : 'credit-clear');
      }
      if (orderStatus) {
        const value = String(orderStatus.textContent || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z]+/g, '-');
        orderStatus.classList.add('status', `status-${value}`);
      }
    });
  new MutationObserver(decorateInsightPills).observe(rows, { childList: true });
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
  let ordersById = new Map();
  const showBill = (order) => {
    if (!order) return;
    const items = Array.isArray(order.items) ? order.items : [];
    const unitPrice = (item) =>
      Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
    const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const calculatedTotal = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0) * unitPrice(item),
      0
    );
    const total = Number(order.total) > 0 ? Number(order.total) : calculatedTotal;
    const orderNumber = String(order.daily_order_number || '—').padStart(2, '0');
    const placed = new Date(order.created_at).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    });
    let dialog = document.getElementById('customer-order-bill-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'customer-order-bill-dialog';
      dialog.className = 'customer-order-bill-dialog';
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = `<button class="bill-close" aria-label="Close bill">×</button><div class="bill-heading"><div><span>Red Lantern Restaurant · staff view</span><h2>Order #${esc(orderNumber)}</h2><p>${esc(placed)} · ${esc(order.status)}</p></div><strong>${money(total)}</strong></div><div class="bill-customer"><div><span>Customer</span><b>${esc(order.customer_name || 'Guest')}</b></div><div><span>Mobile</span><b>${esc(order.customer_phone || '—')}</b></div><div><span>Wallet points</span><b>${Number(order.loyalty_points || 0)}</b></div></div>${order.special_request ? `<div class="bill-request"><b>Special request</b>${esc(order.special_request)}</div>` : ''}<div class="bill-items"><div class="bill-items-head"><span>Item</span><span>Qty</span><span>Price</span><span>Amount</span></div>${
      items
        .map((item) => {
          const qty = Number(item.quantity || 0);
          const price = unitPrice(item);
          const label = `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` · ${item.style}` : ''}`;
          return `<div class="bill-item"><span>${esc(label)}</span><span>${qty}</span><span>${money(price)}</span><span>${money(qty * price)}</span></div>`;
        })
        .join('') || '<p class="help-text">No item details were saved for this order.</p>'
    }</div><div class="bill-total"><span>Total quantity: ${totalQuantity}</span><strong>Grand total ${money(total)}</strong></div>`;
    const printButton = document.createElement('button');
    printButton.type = 'button';
    printButton.className = 'bill-print';
    printButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><path d="M6 14h12v7H6z"></path></svg>Print bill';
    const billActions = document.createElement('div');
    billActions.className = 'bill-actions';
    billActions.append(printButton);
    dialog.querySelector('.bill-total')?.after(billActions);
    printButton.addEventListener('click', () => window.print());
    dialog.showModal();
    dialog.querySelector('.bill-close').addEventListener('click', () => dialog.close());
  };
  const printPaymentSummary = async () => {
    const response = await fetch(
      `/api/register/summary?date=${encodeURIComponent(date.value)}`,
      { cache: 'no-store' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to prepare the payment summary.');
    const payments = Array.isArray(data.orders) ? data.orders : [];
    const paymentName = (type) =>
      ({ cash: 'Cash', upi: 'UPI / GPay', card: 'Card', other: 'Other', due: 'Due' }[type] ||
        'Not recorded');
    const sales = payments.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const tips = payments.reduce((sum, order) => sum + Number(order.tip_amount || 0), 0);
    const popup = window.open('', 'red-lantern-payment-summary', 'popup=yes,width=1000,height=720');
    if (!popup) throw new Error('Allow pop-ups to print the payment summary.');
    popup.document.write(`<!doctype html><title>Payment summary</title><style>body{font:12px Arial;padding:22px;color:#111}h1,p{margin:0 0 7px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:8px;text-align:left;border-bottom:1px solid #ddd}th{font-size:10px;text-transform:uppercase;background:#f3f3f3}.right{text-align:right}.total{margin-top:18px;font-size:14px;font-weight:bold}</style><h1>Red Lantern Restaurant — Payment Summary</h1><p>Date: ${esc(data.day || date.value || '')}</p><table><thead><tr><th>Bill</th><th>Type</th><th>Table / Parcel</th><th>Customer</th><th>Payment</th><th class=right>Bill total</th><th class=right>Received</th><th class=right>Change</th><th class=right>Tip</th></tr></thead><tbody>${payments.map((order) => `<tr><td>#${esc(order.daily_order_number)}</td><td>${order.mode === 'table' ? 'Dine-in' : 'Parcel'}</td><td>${esc(order.mode === 'table' ? `Table ${String(order.table_number || '').padStart(2, '0')}` : (order.customer_phone || 'Walk-in'))}</td><td>${esc(order.customer_name || 'Walk-in customer')}</td><td>${esc(paymentName(order.settlement_type))}</td><td class=right>${money(order.total)}</td><td class=right>${money(order.payment_received ?? order.settlement_amount ?? order.total)}</td><td class=right>${money(order.change_due)}</td><td class=right>${money(order.tip_amount)}</td></tr>`).join('') || '<tr><td colspan=9>No completed payments for this date.</td></tr>'}</tbody></table><p class=total>Sales: ${money(sales)} &nbsp; | &nbsp; Tips: ${money(tips)}</p><script>onload=()=>print()<\/script>`);
    popup.document.close();
  };
  const load = async () => {
    try {
      status.style.color = '';
      status.textContent = 'Loading customer history…';
      const response = await fetch(
        `/api/admin/customer-insights?date=${encodeURIComponent(date.value)}&search=${encodeURIComponent(search.value)}`,
        { cache: 'no-store' }
      );
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          response.status === 401
            ? 'Admin login is required. Please refresh and sign in again.'
            : 'Customer Insights is unavailable. Refresh the local server or deploy the latest code.'
        );
      }
      if (!response.ok) throw new Error(data.error || 'Unable to load customer insights.');
      ordersById = new Map(data.orders.map((order) => [order.id, order]));
      const sales = data.orders.filter(
        (order) => !['cancelled', 'rejected'].includes(order.status)
      );
      const totalSales = sales.reduce((sum, order) => sum + Number(order.total || 0), 0);
      const businessSales = sales
        .filter((order) => order.mode === 'card')
        .reduce((sum, order) => sum + Number(order.total || 0), 0);
      const tableSales = sales
        .filter((order) => order.mode === 'table')
        .reduce((sum, order) => sum + Number(order.total || 0), 0);
      stats.innerHTML = [
        ['Direct Place Order sales', money(totalSales)],
        ['Business Card QR sales', money(businessSales)],
        ['Table QR sales', money(tableSales)],
        ['Live orders', sales.length],
        ['Points in wallets', data.summary.points],
        ['Credit outstanding', money(data.summary.credit)],
      ]
        .map(
          ([label, value]) =>
            `<div class="insight-stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`
        )
        .join('');
      rows.innerHTML = data.orders.length
        ? data.orders
            .map((order) => {
              const items = Array.isArray(order.items)
                ? order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
                : 0;
              const placed = new Date(order.created_at).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              });
              const orderNumber = String(order.daily_order_number || '—').padStart(2, '0');
              return `<tr><td><button type="button" class="insight-order-link" data-insight-order="${esc(order.id)}" aria-label="View bill for order ${esc(orderNumber)}">#${esc(orderNumber)}</button></td><td>${esc(placed)}</td><td><strong>${esc(order.customer_name || 'Guest')}</strong><br>${esc(order.customer_phone)}</td><td>${items} items</td><td><strong>${money(order.total)}</strong></td><td><span class="insight-pill">${Number(order.loyalty_points || 0)} points</span></td><td><span class="insight-pill ${Number(order.credit_balance || 0) > 0 ? 'credit' : ''}">${money(order.credit_balance || 0)}</span></td><td><span class="insight-pill">${esc(order.status)}</span></td></tr>`;
            })
            .join('')
        : '<tr><td colspan="8">No orders match this date or search.</td></tr>';
      leaderboard.innerHTML = data.leaderboard.length
        ? data.leaderboard
            .map(
              (customer, index) =>
                `<div class="customer-leader"><span>#${index + 1} · ${esc(customer.customer_phone)}</span><b>${Number(customer.points || 0)} points</b><span>Earned ${Number(customer.total_earned || 0)} · Redeemed ${Number(customer.total_redeemed || 0)}</span></div>`
            )
            .join('')
        : '<p class="help-text">No loyalty points have been earned yet.</p>';
      status.textContent = `Showing ${data.orders.length} order${data.orders.length === 1 ? '' : 's'}. Select an order number to view its bill. Sales exclude cancelled and rejected orders.`;
    } catch (error) {
      status.textContent = error.message;
      status.style.color = '#b91c1c';
    }
  };
  rows.addEventListener('click', (event) => {
    const button = event.target.closest('[data-insight-order]');
    if (button) showBill(ordersById.get(button.dataset.insightOrder));
  });
  refresh?.addEventListener('click', load);
  printSummary?.addEventListener('click', async () => {
    printSummary.disabled = true;
    try {
      await printPaymentSummary();
    } catch (error) {
      status.textContent = error.message || 'Unable to print the payment summary.';
      status.style.color = '#b91c1c';
    } finally {
      printSummary.disabled = false;
    }
  });
  date.addEventListener('change', load);
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  document.querySelector('[data-target="tab-customer-insights"]')?.addEventListener('click', load);
  load();
}

function setupTrustedContacts() {
  const input = document.getElementById('trusted-contact-import');
  const save = document.getElementById('trusted-contact-import-button');
  const file = document.getElementById('trusted-contact-file');
  const upload = document.getElementById('trusted-contact-upload-button');
  const list = document.getElementById('trusted-contact-list');
  const status = document.getElementById('trusted-contact-status');
  const search = document.getElementById('trusted-contact-search');
  const searchButton = document.getElementById('trusted-contact-search-button');
  const count = document.getElementById('trusted-contact-count');
  const pagination = document.getElementById('trusted-contact-pagination');
  if (!input || !save || !file || !upload || !list || !status || !search || !searchButton || !count || !pagination)
    return;
  let page = 1;
  let contactsByPhone = new Map();
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const purchase = (contact) => {
    const items = Array.isArray(contact.last_items) ? contact.last_items : [];
    if (!items.length) return 'No previous purchase saved';
    return items
      .map((item) => `${Number(item.quantity || 0)}× ${item.name || 'Item'}`)
      .join(', ');
  };
  const load = async () => {
    try {
      const response = await fetch(
        `/api/admin/trusted-contacts?search=${encodeURIComponent(search.value)}&page=${page}&limit=50`,
        { cache: 'no-store' }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load verified contacts.');
      contactsByPhone = new Map(data.contacts.map((contact) => [String(contact.customer_phone), contact]));
      list.innerHTML = data.contacts.length
        ? data.contacts
            .map(
              (contact) =>
                `<article class="trusted-contact-strip" data-trusted-phone="${esc(contact.customer_phone)}"><div><input class="trusted-contact-name" data-trusted-name value="${esc(contact.customer_name || '')}" placeholder="Add a name"><span class="trusted-contact-phone">${esc(contact.customer_phone)}</span></div><div><span class="trusted-contact-status${contact.blocked ? ' is-blocked' : ''}">${contact.blocked ? 'Counter approval required' : 'Auto-accept enabled'}</span></div><div><span class="trusted-contact-history-label">Latest order</span><div class="trusted-contact-history" title="${esc(purchase(contact))}">${esc(purchase(contact))}</div>${contact.last_order_at ? `<span class="trusted-contact-date">${esc(new Date(contact.last_order_at).toLocaleDateString('en-IN'))}</span>` : ''}</div><div class="trusted-contact-actions">${Array.isArray(contact.last_items) && contact.last_items.length ? '<button type="button" class="trusted-contact-view" data-trusted-view>View order</button>' : ''}<button type="button" class="trusted-contact-save" data-trusted-save>${contact.blocked ? 'Unblock' : 'Save name'}</button>${contact.blocked ? '' : '<button type="button" class="trusted-contact-block" data-trusted-block>Block</button>'}</div></article>`
            )
            .join('')
        : '<div class="trusted-contact-list-empty">No contacts match this search.</div>';
      const first = data.total ? (data.page - 1) * data.limit + 1 : 0;
      const last = Math.min(data.page * data.limit, data.total);
      count.textContent = data.total
        ? `Showing ${first}–${last} of ${data.total.toLocaleString('en-IN')} trusted contacts`
        : 'No trusted contacts yet.';
      pagination.innerHTML = `<button type="button" data-trusted-page="previous" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.limit))}</span><button type="button" data-trusted-page="next" ${last >= data.total ? 'disabled' : ''}>Next</button>`;
      setStatus('');
    } catch (error) {
      setStatus(error.message || 'Unable to load verified contacts.', true);
    }
  };
  const update = async (row, blocked) => {
    const phone = row.dataset.trustedPhone;
    const name = row.querySelector('[data-trusted-name]')?.value || '';
    const response = await fetch(`/api/admin/trusted-contacts/${encodeURIComponent(phone)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, blocked }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to update this contact.');
    await load();
  };
  const viewOrder = (contact) => {
    const items = Array.isArray(contact?.last_items) ? contact.last_items : [];
    if (!items.length) return;
    let dialog = document.getElementById('trusted-contact-order-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'trusted-contact-order-dialog';
      dialog.className = 'trusted-contact-order-dialog';
      document.body.appendChild(dialog);
    }
    const placed = contact.last_order_at
      ? new Date(contact.last_order_at).toLocaleDateString('en-IN', {
          dateStyle: 'medium',
        })
      : 'Previous order';
    dialog.innerHTML = `<header><div><h3>Latest order</h3><p>${esc(contact.customer_name || contact.customer_phone)} · ${esc(placed)}</p></div><button type="button" class="trusted-contact-order-close" aria-label="Close">×</button></header><div class="trusted-contact-order-items">${items.map((item) => `<div class="trusted-contact-order-item"><span>${esc(`${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` · ${item.style}` : ''}`)}</span><b>${Number(item.quantity || 0)}×</b></div>`).join('')}</div>`;
    dialog.querySelector('.trusted-contact-order-close').addEventListener('click', () => dialog.close());
    dialog.showModal();
  };
  save.addEventListener('click', async () => {
    const contacts = input.value
      .split(/\r?\n/)
      .map((line) => {
        const pieces = line.split(',');
        return pieces.length > 1
          ? { name: pieces.slice(0, -1).join(',').trim(), phone: pieces.at(-1).trim() }
          : { name: '', phone: line.trim() };
      })
      .filter((contact) => contact.phone);
    if (!contacts.length) return setStatus('Enter at least one mobile number.', true);
    try {
      save.disabled = true;
      const response = await fetch('/api/admin/trusted-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save contacts.');
      input.value = '';
      await load();
      setStatus(`${data.added} contact${data.added === 1 ? '' : 's'} saved and enabled for auto-accept.`);
    } catch (error) {
      setStatus(error.message || 'Unable to save contacts.', true);
    } finally {
      save.disabled = false;
    }
  });
  upload.addEventListener('click', async () => {
    const selected = file.files?.[0];
    if (!selected) return setStatus('Choose the completed Excel template first.', true);
    try {
      upload.disabled = true;
      const form = new FormData();
      form.append('contactsFile', selected);
      const response = await fetch('/api/admin/trusted-contacts/import', {
        method: 'POST',
        body: form,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to import contacts.');
      file.value = '';
      await load();
      setStatus(`${data.added} contact${data.added === 1 ? '' : 's'} imported and enabled for auto-accept.`);
    } catch (error) {
      setStatus(error.message || 'Unable to import contacts.', true);
    } finally {
      upload.disabled = false;
    }
  });
  list.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-trusted-phone]');
    if (!row) return;
    try {
      if (event.target.closest('[data-trusted-view]')) viewOrder(contactsByPhone.get(row.dataset.trustedPhone));
      else if (event.target.closest('[data-trusted-save]')) await update(row, false);
      else if (event.target.closest('[data-trusted-block]')) await update(row, true);
    } catch (error) {
      setStatus(error.message || 'Unable to update this contact.', true);
    }
  });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      page = 1;
      load();
    }, 250);
  });
  searchButton.addEventListener('click', () => {
    page = 1;
    load();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchButton.click();
  });
  pagination.addEventListener('click', (event) => {
    const direction = event.target.closest('[data-trusted-page]')?.dataset.trustedPage;
    if (!direction) return;
    page = direction === 'next' ? page + 1 : Math.max(1, page - 1);
    load();
  });
  document.querySelector('[data-target="tab-trusted-contacts"]')?.addEventListener('click', load);
  load();
}

function setupSmartKds() {
  const form = document.getElementById('smart-kds-config-form');
  const status = document.getElementById('smart-kds-status');
  const courseBody = document.getElementById('smart-kds-course-defaults');
  const stationsRoot = document.getElementById('smart-kds-stations');
  const saveStations = document.getElementById('smart-kds-save-stations');
  if (!form || !status || !courseBody || !stationsRoot || !saveStations) return;
  const panelButtons = [...document.querySelectorAll('[data-smart-kds-panel-target]')];
  const panels = [...document.querySelectorAll('[data-smart-kds-panel]')];
  const selectPanel = (name, { persist = true } = {}) => {
    const selected = panelButtons.some((button) => button.dataset.smartKdsPanelTarget === name)
      ? name
      : 'setup';
    panels.forEach((panel) => { panel.hidden = panel.dataset.smartKdsPanel !== selected; });
    panelButtons.forEach((button) => {
      button.setAttribute('aria-current', button.dataset.smartKdsPanelTarget === selected ? 'page' : 'false');
    });
    document.dispatchEvent(new CustomEvent('smart-kds-panel-change', { detail: selected }));
    if (persist) {
      try { localStorage.setItem('redLanternSmartKdsAdminPanel', selected); } catch (_) { /* optional preference */ }
    }
  };
  if (panelButtons.length && panels.length) {
    let savedPanel = 'setup';
    try { savedPanel = localStorage.getItem('redLanternSmartKdsAdminPanel') || 'setup'; } catch (_) { /* optional preference */ }
    selectPanel(savedPanel, { persist: false });
    panelButtons.forEach((button) => button.addEventListener('click', () => selectPanel(button.dataset.smartKdsPanelTarget)));
  }
  const ids = {
    displayMode: 'smart-kds-display-mode',
    schedulingMode: 'smart-kds-scheduling-mode',
    platingMinutes: 'smart-kds-plating',
    handoffBufferMinutes: 'smart-kds-handoff',
    courseReadyToleranceMinutes: 'smart-kds-tolerance',
    parcelDefaultTargetMinutes: 'smart-kds-parcel',
    defaultWindowSeconds: 'smart-kds-batch-window',
    defaultMaxBatchSize: 'smart-kds-batch-max',
    starvationAfterMinutes: 'smart-kds-starvation',
    firstFoodAfterMinutes: 'smart-kds-first-food-risk',
    serviceGapAfterMinutes: 'smart-kds-service-gap-risk',
    watchMinutes: 'smart-kds-watch-window',
    startSoonMinutes: 'smart-kds-start-soon',
    criticalOverdueMinutes: 'smart-kds-critical-overdue',
  };
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const title = (value) => String(value || '').replace(/^./, (letter) => letter.toUpperCase());
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
    status.hidden = !error && /^Smart KDS is staff-controlled\.?$/i.test(String(message).trim());
  };
  const numberValue = (id) => Number(document.getElementById(id)?.value || 0);
  const renderCourses = (config) => {
    const courses = Array.isArray(config.courseOrder) ? config.courseOrder : [];
    courseBody.innerHTML = courses
      .map((course) => {
        const value = config.courseDefaults?.[course] || {};
        return `<article class="smart-kds-course-target" data-smart-kds-course="${esc(course)}"><div class="smart-kds-course-name"><label class="smart-kds-course-sequence"><span>Order</span><input type="number" min="1" max="${courses.length}" data-course-sequence value="${courses.indexOf(course) + 1}"></label><div><strong>${esc(title(course))} timing</strong><small>Service pattern ${courses.indexOf(course) + 1} of ${courses.length} · not a menu category</small></div></div><label class="smart-kds-course-value"><span>Target from order</span><div><input type="number" min="1" max="240" data-target-min value="${esc(value.targetMin)}"><small>min</small></div></label><label class="smart-kds-course-value"><span>Latest acceptable</span><div><input type="number" min="1" max="300" data-target-max value="${esc(value.targetMax)}"><small>min</small></div></label><label class="smart-kds-course-value"><span>Wait before next course</span><div><input type="number" min="0" max="120" data-spacing value="${esc(value.spacingAfterMin)}"><small>min</small></div></label></article>`;
      })
      .join('');
  };
  const renderStations = (stations) => {
    stationsRoot.innerHTML = stations.length
      ? stations
          .map(
            (station) =>
              `<article class="smart-kds-station" data-smart-kds-station="${esc(station.station_id)}" data-station-printer="${esc(station.printer_id || '')}"><div><strong>${esc(station.station_name)}</strong><small>Linked KOT printer: ${esc(station.printer_id || 'Not linked')}</small></div><label>Capacity <input type="number" min="1" max="50" data-station-capacity value="${esc(station.max_concurrent_tasks || 1)}"></label><label><input type="checkbox" data-station-enabled ${station.enabled !== false ? 'checked' : ''}> Available</label><small>Stored for future Smart KDS planning</small></article>`
          )
          .join('')
      : '<p class="help-text">No KOT printers are configured yet. Add a KOT printer in operations first, then return here.</p>';
  };
  const fill = (data) => {
    const config = data.config || {};
    document.getElementById(ids.displayMode).value = config.displayMode || 'normal';
    document.getElementById(ids.schedulingMode).value = config.mode || 'shadow';
    document.getElementById(ids.platingMinutes).value = config.timing?.platingMinutes ?? '';
    document.getElementById(ids.handoffBufferMinutes).value = config.timing?.handoffBufferMinutes ?? '';
    document.getElementById(ids.courseReadyToleranceMinutes).value = config.timing?.courseReadyToleranceMinutes ?? '';
    document.getElementById(ids.parcelDefaultTargetMinutes).value = config.timing?.parcelDefaultTargetMinutes ?? '';
    document.getElementById(ids.defaultWindowSeconds).value = config.batching?.defaultWindowSeconds ?? '';
    document.getElementById(ids.defaultMaxBatchSize).value = config.batching?.defaultMaxBatchSize ?? '';
    document.getElementById(ids.starvationAfterMinutes).value = config.fairness?.starvationAfterMinutes ?? '';
    document.getElementById(ids.firstFoodAfterMinutes).value = config.serviceRisk?.firstFoodAfterMinutes ?? '';
    document.getElementById(ids.serviceGapAfterMinutes).value = config.serviceRisk?.serviceGapAfterMinutes ?? '';
    document.getElementById(ids.watchMinutes).value = config.riskThresholds?.watchMinutes ?? '';
    document.getElementById(ids.startSoonMinutes).value = config.riskThresholds?.startSoonMinutes ?? '';
    document.getElementById(ids.criticalOverdueMinutes).value = config.riskThresholds?.criticalOverdueMinutes ?? '';
    renderCourses(config);
    renderStations(Array.isArray(data.stations) ? data.stations : []);
  };
  const load = async () => {
    try {
      const response = await fetch('/api/admin/smart-kds/config', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load Smart KDS settings.');
      fill(data);
      setStatus(data.message || 'Smart KDS is staff-controlled.');
    } catch (error) {
      setStatus(error.message || 'Unable to load Smart KDS settings.', true);
    }
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const courseDefaults = {};
    const courseOrder = [...courseBody.querySelectorAll('[data-smart-kds-course]')]
      .map((row, index) => ({ course: row.dataset.smartKdsCourse, sequence: Number(row.querySelector('[data-course-sequence]')?.value || index + 1), index }))
      .sort((left, right) => left.sequence - right.sequence || left.index - right.index)
      .map((entry) => entry.course);
    courseBody.querySelectorAll('[data-smart-kds-course]').forEach((row) => {
      const course = row.dataset.smartKdsCourse;
      courseDefaults[course] = {
        targetMin: Number(row.querySelector('[data-target-min]')?.value || 0),
        targetMax: Number(row.querySelector('[data-target-max]')?.value || 0),
        spacingAfterMin: Number(row.querySelector('[data-spacing]')?.value || 0),
      };
    });
    const submit = form.querySelector('button[type="submit"]');
    try {
      submit.disabled = true;
      const response = await fetch('/api/admin/smart-kds/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { displayMode: document.getElementById(ids.displayMode)?.value || 'normal', mode: document.getElementById(ids.schedulingMode)?.value || 'shadow', courseOrder, courseDefaults, timing: {
          platingMinutes: numberValue(ids.platingMinutes), handoffBufferMinutes: numberValue(ids.handoffBufferMinutes),
          courseReadyToleranceMinutes: numberValue(ids.courseReadyToleranceMinutes), parcelDefaultTargetMinutes: numberValue(ids.parcelDefaultTargetMinutes),
        }, batching: { defaultWindowSeconds: numberValue(ids.defaultWindowSeconds), defaultMaxBatchSize: numberValue(ids.defaultMaxBatchSize) }, fairness: { starvationAfterMinutes: numberValue(ids.starvationAfterMinutes) }, serviceRisk: { firstFoodAfterMinutes: numberValue(ids.firstFoodAfterMinutes), serviceGapAfterMinutes: numberValue(ids.serviceGapAfterMinutes) }, riskThresholds: { watchMinutes: numberValue(ids.watchMinutes), startSoonMinutes: numberValue(ids.startSoonMinutes), criticalOverdueMinutes: numberValue(ids.criticalOverdueMinutes) } } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save Smart KDS settings.');
      renderCourses(data.config);
      setStatus('Smart KDS settings saved. Kitchen staff still choose every action.');
    } catch (error) {
      setStatus(error.message || 'Unable to save Smart KDS settings.', true);
    } finally {
      submit.disabled = false;
    }
  });
  saveStations.addEventListener('click', async () => {
    const stations = [...stationsRoot.querySelectorAll('[data-smart-kds-station]')].map((row) => ({
      station_id: row.dataset.smartKdsStation,
      station_name: row.querySelector('strong')?.textContent || row.dataset.smartKdsStation,
      printer_id: row.dataset.stationPrinter || '',
      max_concurrent_tasks: Number(row.querySelector('[data-station-capacity]')?.value || 1),
      enabled: !!row.querySelector('[data-station-enabled]')?.checked,
    }));
    try {
      saveStations.disabled = true;
      const response = await fetch('/api/admin/smart-kds/stations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stations }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save kitchen stations.');
      renderStations(data.stations || []);
      setStatus('Kitchen station settings saved. They will not change today’s KOT routing.');
    } catch (error) {
      setStatus(error.message || 'Unable to save kitchen stations.', true);
    } finally {
      saveStations.disabled = false;
    }
  });
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
  load();
}

function setupSmartKdsProfiles() {
  const root = document.getElementById('smart-kds-profile-list');
  const status = document.getElementById('smart-kds-profile-status');
  const search = document.getElementById('smart-kds-profile-search');
  const courseFilter = document.getElementById('smart-kds-profile-course-filter');
  const count = document.getElementById('smart-kds-profile-count');
  const more = document.getElementById('smart-kds-load-more-profiles');
  if (!root || !status || !search || !courseFilter || !count || !more) return;
  const courses = ['drink', 'soup', 'starter', 'main', 'side', 'dessert', 'other'];
  const pageSize = 40;
  let items = [];
  let stations = [];
  let coverage = null;
  let page = 1;
  let loading = false;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.style.color = isError ? '#b91c1c' : '';
  };
  const menuCategoryKey = (item) => `${String(item?.menuType || 'food').toLowerCase()}::${String(item?.category || 'Menu').trim() || 'Menu'}`;
  const renderMenuCategoryFilter = () => {
    const selected = courseFilter.value;
    const categories = [...new Map(items.map((item) => [menuCategoryKey(item), `${item.category || 'Menu'}${item.menuType === 'bar' ? ' · Bar menu' : ''}`])).entries()]
      .sort((left, right) => left[1].localeCompare(right[1]));
    courseFilter.innerHTML = `<option value="">All menu categories</option>${categories.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}`;
    courseFilter.value = categories.some(([value]) => value === selected) ? selected : '';
  };
  const filtered = () => {
    const query = search.value.trim().toLowerCase();
    const category = courseFilter.value;
    return items.filter(
      (item) =>
        (!query || `${item.name} ${item.category}`.toLowerCase().includes(query)) &&
        (!category || menuCategoryKey(item) === category)
    );
  };
  const optionList = (value, list) =>
    list.map((option) => `<option value="${esc(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
  const input = (field, value, { min, max, label } = {}) =>
    `<label class="form-group"><span>${esc(label || field)}</span><input data-profile-field="${esc(field)}" type="number" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} value="${esc(value)}"></label>`;
  const check = (field, value, label) =>
    `<label><input data-profile-field="${esc(field)}" type="checkbox" ${value ? 'checked' : ''}> ${esc(label)}</label>`;
  const showLoading = () => {
    count.textContent = 'Loading menu…';
    status.textContent = '';
    root.innerHTML = Array.from({ length: 5 }, () => '<div class="smart-kds-profile-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>').join('');
  };
  const render = () => {
    const rows = filtered();
    const visible = rows.slice(0, page * pageSize);
    const stationNote = Number(coverage?.stationUnassigned || 0)
      ? ` · ${Number(coverage.stationUnassigned).toLocaleString('en-IN')} need station`
      : ' · stations assigned';
    count.textContent = `${rows.length.toLocaleString('en-IN')} of ${items.length.toLocaleString('en-IN')} Air Menu dishes${stationNote}`;
    more.hidden = visible.length >= rows.length;
    more.textContent = `Show ${Math.min(pageSize, rows.length - visible.length)} more dishes`;
    root.innerHTML = visible.length
      ? visible
          .map((item) => {
            const profile = item.profile || {};
            const stationOptions = [{ value: '', label: 'Assign later' }, ...stations.map((station) => ({ value: station.station_id, label: station.station_name }))];
            return `<details class="smart-kds-profile" data-profile-key="${esc(item.itemKey)}"><summary><div><strong>${esc(item.name)}</strong><div class="smart-kds-profile-meta">Air Menu category: ${esc(item.category)} · ${esc(item.menuType === 'bar' ? 'Bar menu' : 'Food menu')}</div></div><span class="smart-kds-profile-course">${esc(item.category || 'Menu')}</span><span class="smart-kds-profile-meta">${esc(stations.find((station) => station.station_id === profile.stationId)?.station_name || 'Station not assigned')}</span><span class="smart-kds-profile-meta">${esc(profile.prepTimeEstimate || '—')} min prep</span></summary><div class="smart-kds-profile-fields"><div class="form-grid"><label class="form-group"><span>Serving timing pattern</span><select data-profile-field="course">${optionList(profile.course, courses.map((course) => ({ value: course, label: course[0].toUpperCase() + course.slice(1) })))}</select><small class="help-text">This controls service timing only. The Air Menu category above remains the kitchen category.</small></label><label class="form-group"><span>Kitchen station</span><select data-profile-field="stationId">${optionList(profile.stationId || '', stationOptions)}</select></label>${input('prepTimeEstimate', profile.prepTimeEstimate, { min: 1, max: 240, label: 'Prep estimate (minutes)' })}${input('minPrepTime', profile.minPrepTime, { min: 1, max: 240, label: 'Minimum prep (minutes)' })}${input('maxPrepTime', profile.maxPrepTime, { min: 1, max: 300, label: 'Maximum prep (minutes)' })}${input('platingTime', profile.platingTime, { min: 0, max: 60, label: 'Plating (minutes)' })}${input('handoffBuffer', profile.handoffBuffer, { min: 0, max: 60, label: 'Handoff buffer (minutes)' })}${input('targetAdjustmentMinutes', profile.targetAdjustmentMinutes, { min: -60, max: 60, label: 'Dish target adjustment (minutes)' })}${input('parallelCapacityCost', profile.parallelCapacityCost, { min: 1, max: 50, label: 'Station capacity cost' })}</div><div class="smart-kds-profile-checks">${check('batchable', profile.batchable, 'Can be batched')}${check('longPrepItem', profile.longPrepItem, 'Long-prep item')}${check('requiresPreviousCourse', profile.requiresPreviousCourse, 'Requires previous course')}${check('canPrePrep', profile.canPrePrep, 'Can pre-prep')}${check('canHoldAfterCooking', profile.canHoldAfterCooking, 'Can hold after cooking')}</div><div class="form-grid"><label class="form-group"><span>Batch group ID</span><input data-profile-field="batchGroupId" type="text" maxlength="120" value="${esc(profile.batchGroupId || '')}" placeholder="Example: MANCHOW_SOUP"></label>${input('maxBatchSize', profile.maxBatchSize, { min: 1, max: 100, label: 'Maximum batch size' })}${input('optimalBatchSize', profile.optimalBatchSize, { min: 1, max: 100, label: 'Optimal batch size' })}${input('batchWindowSeconds', profile.batchWindowSeconds, { min: 0, max: 3600, label: 'Batch window (seconds)' })}${input('maxHoldTime', profile.maxHoldTime, { min: 0, max: 240, label: 'Maximum hold (minutes)' })}${input('priorityModifier', profile.priorityModifier, { min: -100, max: 100, label: 'Priority modifier' })}</div><div class="smart-kds-profile-save"><button type="button" class="btn-save" data-save-profile>Save ${esc(item.name)} profile</button></div></div></details>`;
          })
          .join('')
      : '<p class="help-text">No menu dishes match this filter.</p>';
  };
  const load = async () => {
    if (loading) return;
    loading = true;
    showLoading();
    try {
      const response = await fetch('/api/admin/smart-kds/menu-profiles', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load menu production profiles.');
      items = Array.isArray(data.items) ? data.items : [];
      stations = Array.isArray(data.stations) ? data.stations : [];
      coverage = data.coverage && typeof data.coverage === 'object' ? data.coverage : null;
      renderMenuCategoryFilter();
      page = 1;
      render();
      const missing = Number(coverage?.missing || 0);
      const duplicates = Number(coverage?.duplicateMenuKeys || 0);
      setStatus(
        missing
          ? `${missing} menu profile${missing === 1 ? '' : 's'} could not be saved. Refresh and try again.`
          : duplicates
            ? `${data.message || 'Profiles are ready.'} ${duplicates} duplicate menu key${duplicates === 1 ? '' : 's'} share one profile; rename duplicate dishes to manage them separately.`
            : data.message || 'Every current menu item has a saved production profile.',
        missing > 0
      );
    } catch (error) {
      root.innerHTML = '<div class="smart-kds-profile-empty"><strong>Could not load production profiles</strong><span>Check the connection, then try again.</span><button type="button" data-retry-profiles>Try again</button></div>';
      count.textContent = 'Unable to load menu';
      setStatus(error.message || 'Unable to load menu production profiles.', true);
    } finally {
      loading = false;
    }
  };
  const save = async (card) => {
    const item = items.find((entry) => entry.itemKey === card.dataset.profileKey);
    if (!item) return;
    const profile = { itemKey: item.itemKey };
    card.querySelectorAll('[data-profile-field]').forEach((field) => {
      const key = field.dataset.profileField;
      profile[key] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value;
    });
    const button = card.querySelector('[data-save-profile]');
    try {
      button.disabled = true;
      const response = await fetch('/api/admin/smart-kds/menu-profiles', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles: [profile] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save this production profile.');
      const saved = data.saved?.[0]?.profile;
      if (saved) item.profile = saved;
      render();
      setStatus(`${item.name} production profile saved. KOT flow is still unchanged.`);
    } catch (error) {
      setStatus(error.message || 'Unable to save this production profile.', true);
    } finally {
      button.disabled = false;
    }
  };
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { page = 1; render(); }, 180);
  });
  courseFilter.addEventListener('change', () => { page = 1; render(); });
  more.addEventListener('click', () => { page += 1; render(); });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-profiles]')) return load();
    const button = event.target.closest('[data-save-profile]');
    if (button) save(button.closest('[data-profile-key]'));
  });
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
  document.addEventListener('smart-kds-panel-change', (event) => {
    if (event.detail === 'profiles' && !items.length) load();
  });
  if (document.querySelector('[data-smart-kds-panel-target="profiles"]')?.getAttribute('aria-current') === 'page') load();
}

function setupSmartKdsTiming() {
  const refresh = document.getElementById('smart-kds-refresh-timing');
  const status = document.getElementById('smart-kds-timing-status');
  const summary = document.getElementById('smart-kds-timing-summary');
  const ordersRoot = document.getElementById('smart-kds-timing-orders');
  if (!refresh || !status || !summary || !ordersRoot) return;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const format = (value) =>
    value
      ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(value))
      : '—';
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const orderLabel = (order) => {
    if (order.mode === 'table') return `${order.tableArea || 'Table'} · ${order.tableNumber || '—'}`;
    return order.fulfillmentType === 'delivery' ? 'Delivery order' : 'Parcel / takeaway';
  };
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [
      ['safe', 'Safe'], ['watch', 'Watch'], ['start-soon', 'Start soon'], ['start-now', 'Start now'],
      ['at-risk', 'At risk'], ['overdue', 'Overdue'], ['critical', 'Critical'],
    ].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    ordersRoot.innerHTML = data.orders?.length
      ? data.orders.map((order) => `<article class="smart-kds-timing-order"><header><div><h3>#${esc(String(order.orderNumber || '—').padStart(2, '0'))} · ${esc(orderLabel(order))}</h3><p>${esc(order.customerName)} · Ordered ${esc(format(order.orderedAt))} · ${esc(order.status)}</p></div><span class="insight-pill">${order.tasks.length} item${order.tasks.length === 1 ? '' : 's'}</span></header>${order.tasks.map((task) => `<div class="smart-kds-timing-task"><div><strong>${esc(`${task.quantity}× ${task.itemName}`)}</strong><small>${esc(`${task.course} · ${task.stationId || 'Station not assigned'} · ${task.prepWindowMinutes} min total prep window`)}</small></div><div><span class="smart-kds-timing-state ${esc(task.state)}">${esc(task.state.replace('-', ' '))}</span><small>${esc(task.reason)}</small></div><div><strong>Target serve</strong><small>${esc(format(task.targetServeAt))}</small></div><div><strong>Latest safe start</strong><small>${esc(format(task.latestSafeStartAt))}</small></div><div><strong>Maximum serve</strong><small>${esc(format(task.latestAcceptableServeAt))}</small></div></div>`).join('')}</article>`).join('')
      : '<p class="help-text">There are no accepted, preparing, or ready orders to calculate right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Calculating timing shadow…');
      const response = await fetch('/api/admin/smart-kds/timing-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate timing preview.');
      render(data);
      setStatus(`${data.message} Calculated ${Number(data.summary?.tasks || 0)} item${Number(data.summary?.tasks || 0) === 1 ? '' : 's'} at ${format(data.generatedAt)}.`);
    } catch (error) {
      setStatus(error.message || 'Unable to calculate timing preview.', true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsScheduler() {
  const refresh = document.getElementById('smart-kds-refresh-scheduler');
  const status = document.getElementById('smart-kds-scheduler-status');
  const summary = document.getElementById('smart-kds-scheduler-summary');
  const list = document.getElementById('smart-kds-scheduler-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const format = (value) =>
    value ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const orderLabel = (task) =>
    task.mode === 'table'
      ? `${task.tableArea || 'Table'} · ${task.tableNumber || '—'}`
      : task.fulfillmentType === 'delivery'
        ? 'Delivery order'
        : 'Parcel / takeaway';
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [
      ['start-now', 'Start now'], ['prepare-next', 'Prepare next'], ['monitor', 'Monitor'], ['tasks', 'Active items'],
    ].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    list.innerHTML = data.recommendations?.length
      ? data.recommendations.map((task) => `<article class="smart-kds-priority-card"><span class="smart-kds-priority-rank">${Number(task.rank)}</span><div><strong>${esc(`${task.quantity}× ${task.itemName}`)}</strong><p>#${esc(String(task.orderNumber || '—').padStart(2, '0'))} · ${esc(orderLabel(task))} · ${esc(task.stationId || 'Station not assigned')}</p></div><div><span class="smart-kds-timing-state ${esc(task.action)}">${esc(task.action.replace('-', ' '))}</span><p>Safe start: ${esc(format(task.latestSafeStartAt))}</p></div><div class="smart-kds-priority-reasons">${(task.reasons || []).map((reason) => `<span>${esc(reason)}</span>`).join('')}</div></article>`).join('')
      : '<p class="help-text">There are no active items to rank right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Calculating deterministic priorities…');
      const response = await fetch('/api/admin/smart-kds/scheduler-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate priorities.');
      render(data);
      setStatus(`${data.message} ${Number(data.summary?.tasks || 0)} active item${Number(data.summary?.tasks || 0) === 1 ? '' : 's'} ranked.`);
    } catch (error) {
      setStatus(error.message || 'Unable to calculate priorities.', true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsBatching() {
  const refresh = document.getElementById('smart-kds-refresh-batches');
  const status = document.getElementById('smart-kds-batch-status');
  const summary = document.getElementById('smart-kds-batch-summary');
  const list = document.getElementById('smart-kds-batch-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const format = (value) =>
    value ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [
      ['fire-batch', 'Close / fire batches'], ['wait-for-batch', 'Waiting safely'], ['batches', 'Compatible batches'], ['allocatedItems', 'Allocated portions'],
    ].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    list.innerHTML = data.batches?.length
      ? data.batches.map((batch) => `<article class="smart-kds-batch-card"><div><h3>${esc(batch.batchGroupId)} · ${Number(batch.totalQuantity)} portions</h3><p>${esc(batch.stationId)} · maximum ${Number(batch.maxBatchSize)} · safe start ${esc(format(batch.latestSafeStartAt))}</p></div><div><span class="smart-kds-timing-state ${esc(batch.action)}">${esc(batch.action.replace('-', ' '))}</span><p>${esc(batch.reason)}</p></div><div class="smart-kds-batch-allocations">${batch.allocations.map((allocation) => `<span>#${esc(String(allocation.orderNumber || '—').padStart(2, '0'))} · ${esc(`${allocation.quantity}× ${allocation.itemName}`)}</span>`).join('')}</div></article>`).join('')
      : '<p class="help-text">No compatible, batchable active items need a batch recommendation right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Calculating compatible batches…');
      const response = await fetch('/api/admin/smart-kds/batch-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate batches.');
      render(data);
      setStatus(`${data.message} ${Number(data.summary?.batches || 0)} compatible batch${Number(data.summary?.batches || 0) === 1 ? '' : 'es'} found.`);
    } catch (error) {
      setStatus(error.message || 'Unable to calculate batches.', true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsCapacity() {
  const refresh = document.getElementById('smart-kds-refresh-capacity');
  const status = document.getElementById('smart-kds-capacity-status');
  const summary = document.getElementById('smart-kds-capacity-summary');
  const list = document.getElementById('smart-kds-capacity-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const workRow = (work) => `<div class="smart-kds-capacity-work-row"><div><strong>${esc(work.label)}</strong><small>Priority #${Number(work.rank || 0)} · ${Number(work.capacityCost || 0)} capacity · ${esc(work.capacityReason)}</small></div><span class="smart-kds-timing-state ${esc(work.capacityState)}">${esc(work.capacityState.replace('-', ' '))}</span></div>`;
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [
      ['allocated', 'Allocated now'], ['capacityWait', 'Waiting for capacity'], ['unassigned', 'No station assigned'], ['overCapacity', 'Already over capacity'], ['stations', 'Stations reviewed'],
    ].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    const plans = data.stationPlans || [];
    const stations = plans.map((station) => {
      const total = Number(station.totalCapacity || 0);
      const used = Number(station.usedCapacity || 0);
      const percent = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const allocations = station.allocations || [];
      const overloaded = Number(station.overCapacity || 0) > 0;
      const detail = !station.enabled ? 'Station marked unavailable' : overloaded ? `${used} of ${total} capacity in use · already ${Number(station.overCapacity)} over limit` : `${used} of ${total} capacity allocated · ${Number(station.remainingCapacity || 0)} free`;
      return `<article class="smart-kds-capacity-card"><div class="smart-kds-capacity-head"><div><h3>${esc(station.stationName)}</h3><p>${detail}</p></div><span class="smart-kds-timing-state ${!station.enabled ? 'unassigned' : overloaded || used >= total ? 'capacity-wait' : 'allocated'}">${!station.enabled ? 'unavailable' : overloaded ? 'over capacity' : 'available'}</span></div><div class="smart-kds-capacity-meter"><b class="${used >= total && total ? 'full' : ''}" style="width:${percent}%"></b></div><div class="smart-kds-capacity-work">${allocations.length ? allocations.map(workRow).join('') : '<p class="help-text">No active work assigned to this station.</p>'}</div></article>`;
    }).join('');
    const unassigned = data.unassigned?.length
      ? `<article class="smart-kds-capacity-card"><div class="smart-kds-capacity-head"><div><h3>Needs station assignment</h3><p>These items cannot receive capacity until their production profile is assigned to a kitchen station.</p></div><span class="smart-kds-timing-state unassigned">review</span></div><div class="smart-kds-capacity-work">${data.unassigned.map(workRow).join('')}</div></article>`
      : '';
    list.innerHTML = `${stations}${unassigned}` || '<p class="help-text">There are no active items that require station capacity right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Allocating station capacity…');
      const response = await fetch('/api/admin/smart-kds/capacity-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate station capacity.');
      render(data);
      setStatus(`${data.message} ${Number(data.summary?.allocated || 0)} work item${Number(data.summary?.allocated || 0) === 1 ? '' : 's'} can start with available capacity.`);
    } catch (error) {
      setStatus(error.message || 'Unable to calculate station capacity.', true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsPacing() {
  const refresh = document.getElementById('smart-kds-refresh-pacing');
  const status = document.getElementById('smart-kds-pacing-status');
  const summary = document.getElementById('smart-kds-pacing-summary');
  const list = document.getElementById('smart-kds-pacing-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
    );
  const format = (value) =>
    value ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
  const title = (value) => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const setStatus = (message = '', error = false) => {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '';
  };
  const orderLabel = (order) =>
    order.mode === 'table'
      ? `${order.tableArea || 'Table'} · ${order.tableNumber || '—'}`
      : order.fulfillmentType === 'delivery' ? 'Delivery order' : 'Parcel / takeaway';
  const renderTask = (task) => `<div class="smart-kds-pacing-task"><div><strong>${esc(`${task.quantity}× ${task.itemName}`)}</strong><small>${esc(task.stationId || 'Station not assigned')} · start ${esc(format(task.plannedStartAt))}</small></div><div><span class="smart-kds-timing-state ${esc(task.pacingState)}">${esc(title(task.pacingState))}</span><small>${esc(task.pacingReason)}</small></div><div><strong>Ready window</strong><small>${esc(format(task.readyWindowStartAt))} – ${esc(format(task.readyWindowEndAt))}</small></div></div>`;
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [
      ['currentCourse', 'Next-course items'], ['prePrep', 'Safe pre-prep'], ['holdForCourse', 'Course holds'], ['synchronized', 'Synchronized items'],
    ].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    list.innerHTML = data.orders?.length
      ? data.orders.map((order) => `<article class="smart-kds-pacing-order"><header><div><h3>#${esc(String(order.orderNumber || '—').padStart(2, '0'))} · ${esc(orderLabel(order))}</h3><p>${esc(order.customerName || 'Walk-in customer')} · ${esc(title(order.courseMode))}${order.nextExpectedCourse ? ` · next: ${esc(title(order.nextExpectedCourse))}` : ''}</p></div><span class="insight-pill">±${Number(order.toleranceMinutes || 0)} min ready window</span></header>${(order.courses || []).map((course) => `<section class="smart-kds-pacing-course"><div class="smart-kds-pacing-course-head"><div><strong>${esc(title(course.course))}</strong><small> · course ${Number(course.sequence)}</small></div><div><small>Target ${esc(format(course.targetServeAt))}</small><span class="smart-kds-timing-state ${esc(course.state === 'next' ? 'current-course' : course.state === 'together' ? 'sync-watch' : 'hold-for-course')}">${esc(title(course.state))}</span></div></div>${course.tasks.map(renderTask).join('')}</section>`).join('')}</article>`).join('')
      : '<p class="help-text">There are no accepted, preparing, or ready orders to pace right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Calculating course pacing…');
      const response = await fetch('/api/admin/smart-kds/pacing-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate course pacing.');
      render(data);
      setStatus(`${data.message} ${Number(data.summary?.orders || 0)} active order${Number(data.summary?.orders || 0) === 1 ? '' : 's'} reviewed.`);
    } catch (error) {
      setStatus(error.message || 'Unable to calculate course pacing.', true);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsTimingOverrides() {
  const category = document.getElementById('smart-kds-category-override');
  const categoryValue = document.getElementById('smart-kds-category-adjustment');
  const station = document.getElementById('smart-kds-station-override');
  const stationTargetValue = document.getElementById('smart-kds-station-target-adjustment');
  const stationValue = document.getElementById('smart-kds-station-adjustment');
  const save = document.getElementById('smart-kds-save-timing-overrides');
  const status = document.getElementById('smart-kds-timing-overrides-status');
  if (!category || !categoryValue || !station || !stationTargetValue || !stationValue || !save || !status) return;
  let config = null;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const setStatus = (message, error = false) => { status.textContent = message || ''; status.style.color = error ? '#b91c1c' : ''; };
  const refreshInputs = () => {
    categoryValue.value = Number(config?.timing?.categoryTargetAdjustments?.[category.value] || 0);
    stationTargetValue.value = Number(config?.timing?.stationTargetAdjustments?.[station.value] || 0);
    stationValue.value = Number(config?.timing?.stationHandoffAdjustments?.[station.value] || 0);
  };
  const load = async () => {
    try {
      const [configResponse, profilesResponse] = await Promise.all([fetch('/api/admin/smart-kds/config', { cache: 'no-store' }), fetch('/api/admin/smart-kds/menu-profiles', { cache: 'no-store' })]);
      const [configData, profilesData] = await Promise.all([configResponse.json(), profilesResponse.json()]);
      if (!configResponse.ok || !profilesResponse.ok) throw new Error(configData.error || profilesData.error || 'Unable to load timing adjustments.');
      config = configData.config;
      const categories = [...new Set((profilesData.items || []).map((item) => `${item.menuType}::${item.category}`))].sort();
      category.innerHTML = categories.map((key) => `<option value="${esc(key)}">${esc(key.replace('::', ' · '))}</option>`).join('') || '<option value="">No menu categories</option>';
      station.innerHTML = (profilesData.stations || []).map((item) => `<option value="${esc(item.station_id)}">${esc(item.station_name)}</option>`).join('') || '<option value="">No stations</option>';
      refreshInputs();
    } catch (error) { setStatus(error.message || 'Unable to load timing adjustments.', true); }
  };
  category.addEventListener('change', refreshInputs);
  station.addEventListener('change', refreshInputs);
  save.addEventListener('click', async () => {
    if (!config) return;
    try {
      save.disabled = true;
      config.timing = config.timing || {};
      config.timing.categoryTargetAdjustments = config.timing.categoryTargetAdjustments || {};
      config.timing.stationTargetAdjustments = config.timing.stationTargetAdjustments || {};
      config.timing.stationHandoffAdjustments = config.timing.stationHandoffAdjustments || {};
      if (category.value) config.timing.categoryTargetAdjustments[category.value] = Number(categoryValue.value || 0);
      if (station.value) config.timing.stationTargetAdjustments[station.value] = Number(stationTargetValue.value || 0);
      if (station.value) config.timing.stationHandoffAdjustments[station.value] = Number(stationValue.value || 0);
      const response = await fetch('/api/admin/smart-kds/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save timing adjustments.');
      config = data.config;
      refreshInputs();
      setStatus('Category and station timing adjustments saved.');
    } catch (error) { setStatus(error.message || 'Unable to save timing adjustments.', true); } finally { save.disabled = false; }
  });
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsFairness() {
  const refresh = document.getElementById('smart-kds-refresh-fairness');
  const status = document.getElementById('smart-kds-fairness-status');
  const summary = document.getElementById('smart-kds-fairness-summary');
  const list = document.getElementById('smart-kds-fairness-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const setStatus = (message = '', error = false) => { status.textContent = message; status.style.color = error ? '#b91c1c' : ''; };
  const render = (data) => {
    const totals = data.summary || {};
    summary.innerHTML = [['protected', 'Fairness protected'], ['longestWaitMinutes', 'Longest wait (min)'], ['thresholdMinutes', 'Threshold (min)'], ['tasks', 'Active items']].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
    list.innerHTML = data.recommendations?.length
      ? data.recommendations.map((task) => `<article class="smart-kds-fairness-card"><span class="smart-kds-priority-rank">${Number(task.fairnessRank || task.rank)}</span><div><strong>${esc(`${task.quantity}× ${task.itemName}`)}</strong><p>#${esc(String(task.orderNumber || '—').padStart(2, '0'))} · waited ${Number(task.waitedMinutes || 0)} min · original priority #${Number(task.originalRank || task.rank || 0)}</p></div><div><span class="smart-kds-timing-state ${task.protectedByFairness ? 'fairness-protected' : esc(task.action)}">${task.protectedByFairness ? 'fairness protected' : esc(task.action.replace('-', ' '))}</span><p>${esc(task.fairnessReason)}</p></div></article>`).join('')
      : '<p class="help-text">There are no active items to evaluate for fairness right now.</p>';
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Applying deterministic fairness rules…');
      const response = await fetch('/api/admin/smart-kds/fairness-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate fairness.');
      render(data);
      setStatus(`${data.message} ${Number(data.summary?.protected || 0)} item${Number(data.summary?.protected || 0) === 1 ? '' : 's'} protected.`);
    } catch (error) { setStatus(error.message || 'Unable to calculate fairness.', true); } finally { refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsRecommendations() {
  const refresh = document.getElementById('smart-kds-refresh-recommendations');
  const status = document.getElementById('smart-kds-recommendations-status');
  const summary = document.getElementById('smart-kds-recommendations-summary');
  const list = document.getElementById('smart-kds-recommendations-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const setStatus = (message = '', error = false) => { status.textContent = message; status.style.color = error ? '#b91c1c' : ''; };
  const load = async () => {
    try {
      refresh.disabled = true; setStatus('Combining Smart KDS constraints…');
      const response = await fetch('/api/admin/smart-kds/recommendations-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate final recommendations.');
      const totals = data.summary || {};
      summary.innerHTML = [['startNow', 'Start now'], ['serviceRisk', 'Service-risk boost'], ['waitingCapacity', 'Waiting capacity'], ['needsStation', 'Needs station']].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
      list.innerHTML = data.recommendations?.length ? data.recommendations.map((task) => `<article class="smart-kds-fairness-card"><span class="smart-kds-priority-rank">${Number(task.finalRank || 0)}</span><div><strong>${esc(`${task.quantity}× ${task.itemName}`)}</strong><p>#${esc(String(task.orderNumber || '—').padStart(2, '0'))} · ${esc(task.stationId || 'Station not assigned')} · ${esc(task.pacingState || 'eligible')}</p></div><div><span class="smart-kds-timing-state ${esc(task.action)}">${esc(task.action.replace('-', ' '))}</span><p>${esc(task.finalReason)}</p></div></article>`).join('') : '<p class="help-text">There are no currently eligible items to recommend.</p>';
      setStatus(data.message);
    } catch (error) { setStatus(error.message || 'Unable to calculate final recommendations.', true); } finally { refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsServiceRisk() {
  const refresh = document.getElementById('smart-kds-refresh-service-risk');
  const status = document.getElementById('smart-kds-service-risk-status');
  const summary = document.getElementById('smart-kds-service-risk-summary');
  const list = document.getElementById('smart-kds-service-risk-list');
  if (!refresh || !status || !summary || !list) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const setStatus = (message = '', error = false) => { status.textContent = message; status.style.color = error ? '#b91c1c' : ''; };
  const load = async () => {
    try {
      refresh.disabled = true; setStatus('Reviewing table service risk…');
      const response = await fetch('/api/admin/smart-kds/service-risk-preview', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to calculate table service risk.');
      const totals = data.summary || {};
      summary.innerHTML = [['firstFoodRisk', 'First-food risk'], ['serviceGapRisk', 'Service-gap risk'], ['critical', 'Critical tables'], ['completedService', 'Service complete'], ['tables', 'Tables reviewed']].map(([key, label]) => `<div class="smart-kds-timing-stat"><b>${Number(totals[key] || 0)}</b><span>${label}</span></div>`).join('');
      list.innerHTML = data.risks?.length ? data.risks.map((risk) => `<article class="smart-kds-fairness-card"><span class="smart-kds-priority-rank">${esc(String(risk.tableNumber || '—'))}</span><div><strong>${esc(risk.tableArea || 'Table')} · ${esc(risk.customerName || 'Walk-in customer')}</strong><p>#${esc(String(risk.orderNumber || '—').padStart(2, '0'))} · ${risk.hasPendingFood ? (risk.hasEverReceivedFood ? `last food ${Number(risk.minutesSinceLastFood)} min ago` : `no food after ${Number(risk.ageMinutes)} min`) : 'all ordered courses served'}</p></div><div><span class="smart-kds-timing-state ${esc(risk.riskType)}">${esc(risk.riskType.replace(/-/g, ' '))}</span><p>${esc(risk.reason)}</p></div></article>`).join('') : '<p class="help-text">There are no active dine-in tables to review right now.</p>';
      setStatus(data.message);
    } catch (error) { setStatus(error.message || 'Unable to calculate table service risk.', true); } finally { refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

function setupSmartKdsMetrics() {
  const refresh = document.getElementById('smart-kds-refresh-metrics');
  const days = document.getElementById('smart-kds-metrics-days');
  const status = document.getElementById('smart-kds-metrics-status');
  const summary = document.getElementById('smart-kds-metrics-summary');
  const courses = document.getElementById('smart-kds-metrics-courses');
  const stations = document.getElementById('smart-kds-metrics-stations');
  const audit = document.getElementById('smart-kds-metrics-audit');
  const auditSearch = document.getElementById('smart-kds-metrics-audit-search');
  if (!refresh || !days || !status || !summary || !courses || !stations || !audit || !auditSearch) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
  const number = (value, suffix = '') => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 })}${suffix}` : '—';
  const mins = (value) => number(value, ' min');
  const format = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
  const setStatus = (message = '', error = false) => { status.textContent = message; status.style.color = error ? '#b91c1c' : ''; };
  const renderRow = (title, detail, value) => `<article class="smart-kds-metrics-row"><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div><b>${esc(value)}</b></article>`;
  let auditEntries = [];
  const renderAudit = () => {
    const query = auditSearch.value.trim().toLowerCase();
    const entries = auditEntries.filter((entry) => !query || `${entry.taskId || ''} ${entry.orderId || ''} ${entry.action || ''} ${entry.actor || ''} ${(entry.reasonCodes || []).join(' ')} ${JSON.stringify(entry.details || {})}`.toLowerCase().includes(query));
    audit.innerHTML = entries.length ? entries.map((entry) => {
      const codes = Array.isArray(entry.reasonCodes) && entry.reasonCodes.length ? entry.reasonCodes.join(', ') : '';
      const details = entry.details?.reason || entry.details?.stationId || entry.details?.capacityState || codes || 'Saved kitchen record';
      const label = entry.type === 'decision' ? `Decision · ${entry.action}` : entry.type === 'order-event' ? `Order record · ${entry.action}` : entry.action;
      return `<article class="smart-kds-audit-row"><small>${esc(format(entry.at))}</small><strong>${esc(label)}</strong><span>${esc(entry.actor || (entry.rank ? `Priority #${entry.rank}` : 'Scheduler'))}</span><small>${esc(`${entry.taskId || entry.orderId || '—'} · ${details}`)}</small></article>`;
    }).join('') : `<p class="help-text">${query ? 'No saved audit records match this search.' : 'No Smart KDS decisions or staff actions were recorded in this period yet.'}</p>`;
  };
  const render = (data) => {
    const total = data.summary || {};
    summary.innerHTML = [
      ['Average first food', mins(total.averageFirstFoodMinutes)], ['Order SLA', number(total.orderSlaPercent, '%')], ['Completed orders measured', number(total.ordersMeasured)],
      ['Late courses', number(total.lateCourses)], ['Ready → served', mins(total.averageReadyToServedMinutes)],
      ['Prep estimate error', mins(total.averagePrepEstimateErrorMinutes)],
      ['Service gap', mins(total.averageServiceGapMinutes)], ['Table service gaps', number(total.tableServiceGaps)], ['Batch efficiency', number(total.batchEfficiencyPercent, '%')],
      ['Average batch size', number(total.averageBatchSize)], ['Refires', number(total.refires)],
      ['Cancellations', number(total.cancellations)], ['Manual overrides', number(total.manualOverrides)], ['Staff actions', number(total.staffActions)],
    ].map(([label, value]) => `<div class="smart-kds-timing-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
    courses.innerHTML = data.courses?.length ? data.courses.map((course) => renderRow(
      `${String(course.course || 'other').replace(/^./, (letter) => letter.toUpperCase())} course`,
      `${number(course.served)} served · ${number(course.late)} late · average ${mins(course.averageServiceMinutes)}`,
      number(course.slaPercent, '%')
    )).join('') : '<p class="help-text">No served course records in this period yet.</p>';
    stations.innerHTML = data.stations?.length ? data.stations.map((station) => renderRow(
      station.stationName,
      `${number(station.tasks)} tasks · queue ${mins(station.averageQueueMinutes)} · prep error ${mins(station.prepEstimateErrorMinutes)}`,
      `${number(station.utilizationPercent, '%')} used`
    )).join('') : '<p class="help-text">No kitchen task records in this period yet.</p>';
    auditEntries = Array.isArray(data.audit) ? data.audit : [];
    renderAudit();
  };
  const load = async () => {
    try {
      refresh.disabled = true;
      setStatus('Calculating saved kitchen performance…');
      const response = await fetch(`/api/admin/smart-kds/metrics?days=${encodeURIComponent(days.value)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load Smart KDS metrics.');
      render(data);
      setStatus(`${data.message} Reporting period: last ${Number(data.rangeDays)} days.`);
    } catch (error) { setStatus(error.message || 'Unable to load Smart KDS metrics.', true); }
    finally { refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  days.addEventListener('change', load);
  auditSearch.addEventListener('input', renderAudit);
  document.querySelector('[data-target="tab-smart-kds"]')?.addEventListener('click', load);
}

fetch('/api/admin/content')
  .then((response) => (response.ok ? response.json() : {}))
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
    loadTableQrCodes();
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
setupCustomerInsights();
setupTrustedContacts();
setupSmartKds();
setupSmartKdsProfiles();
setupSmartKdsTiming();
setupSmartKdsScheduler();
setupSmartKdsBatching();
setupSmartKdsCapacity();
setupSmartKdsPacing();
setupSmartKdsTimingOverrides();
setupSmartKdsFairness();
setupSmartKdsRecommendations();
setupSmartKdsServiceRisk();
setupSmartKdsMetrics();

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
      form
        .querySelectorAll('.blog-entry')
        .forEach((entry) => updateBlogGeneratedDescriptions(entry));
    }

    try {
      const formData = await buildOptimizedFormData(form);
      setStatus(form, 'Saving...');
      const response = await fetch(form.action, {
        method: 'POST',
        body: formData,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text);
      setStatus(form, '');
      showSaveToast();
    } catch (error) {
      setStatus(form, error.message || 'Save failed.', true);
    }
  });
});

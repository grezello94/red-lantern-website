const params = new URLSearchParams(window.location.search);
const fallbackUrl = 'https://www.redlanternrestaurant.in/menu';
const expires = Number(params.get('expires'));
const orderStorageKey = `red-lantern-order:${params.get('signature') || expires}`;
const directOrderRequestKey = `${orderStorageKey}:request-id`;
const orderCatalog = new Map();
let orderSelections = {};
let orderShowsPrices = false;
let orderWhatsAppNumber = '';
let orderIsBusinessCard = false;
let orderCustomerPhone = localStorage.getItem('red-lantern-order-phone') || '';
let directOrdersEnabled = false;
let loyaltyPoints = 0;
let loyaltyLookupTimer = null;
let directOrderRequestId = sessionStorage.getItem(directOrderRequestKey) || '';
let proximityProof = null;
let activeMenu = null;
const menuCacheKey = `red-lantern-menu:${params.get('signature') || expires || 'public'}`;
function distanceInMetres(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (value) => (Number(value) * Math.PI) / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function verifyProximity(proximity) {
  if (!proximity?.required) return Promise.resolve();
  if (!navigator.geolocation)
    return Promise.reject(new Error('This device cannot verify its location.'));
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (position) => {
        proximityProof = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        const distance = distanceInMetres(
          proximity.latitude,
          proximity.longitude,
          proximityProof.latitude,
          proximityProof.longitude
        );
        const accuracyAllowance = Math.min(100, Math.max(0, Number(proximityProof.accuracy) || 0));
        if (distance > Number(proximity.radius) + accuracyAllowance) {
          const error = new Error('outside-proximity-radius');
          error.code = 'outside-proximity-radius';
          return reject(error);
        }
        resolve();
      },
      () => reject(new Error('Location permission is required to place an order from this QR code.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    )
  );
}

function proximityCallLink(menu) {
  const phone = String(menu.cardOrderPhone || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '';
  return `<a class="proximity-call-button" href="tel:${phone.startsWith('+') ? '+' : ''}${digits}"><span aria-hidden="true">☎</span> Call to Place an Order</a>`;
}

function orderPhoneDetails(menu = activeMenu) {
  const phone = String(menu?.cardOrderPhone || '').trim();
  const digits = phone.replace(/\D/g, '');
  return {
    digits,
    dialNumber: `${phone.startsWith('+') ? '+' : ''}${digits}`,
  };
}

function scannedTableLabel(menu = activeMenu) {
  if (menu?.tableLabel) return menu.tableLabel;
  const table = params.get('table');
  return table ? `Table ${table}` : '';
}

function orderFallbackActions(menu = activeMenu) {
  const { digits, dialNumber } = orderPhoneDetails(menu);
  const whatsappCopy = `*Red Lantern Order Request*\n\n${orderSummaryText()}`;
  if (digits.length < 7)
    return '<p class="order-outage-contact">Please call a member of our team to place your order.</p>';
  return `<div class="order-outage-actions"><a class="order-outage-call" href="tel:${dialNumber}"><span aria-hidden="true">☎</span> Call to Place Order</a><a class="order-outage-whatsapp" href="https://wa.me/${digits}?text=${encodeURIComponent(whatsappCopy)}" target="_blank" rel="noopener"><span aria-hidden="true">◉</span> Send Order on WhatsApp</a></div>`;
}

function showOrderOutageFallback(menu = activeMenu, { fullScreen = false } = {}) {
  const tableLabel = scannedTableLabel(menu);
  const tableCopy = tableLabel
    ? `<p class="order-outage-table">Your scanned table: <strong>${escapeHtml(tableLabel)}</strong></p>`
    : '';
  const content = `<section class="order-outage-fallback" role="alert"><span class="order-outage-icon" aria-hidden="true">⌁</span><p class="eyebrow">Ordering service temporarily unavailable</p><h2>Online ordering is taking longer than usual.</h2><p>Your order has <strong>not</strong> been sent, so it cannot be duplicated.</p>${tableCopy}<p class="order-outage-help">Call us or send your selected items on WhatsApp and our team will take your order right away.</p>${orderFallbackActions(menu)}</section>`;
  if (fullScreen) {
    document.querySelector('.menu-tools').hidden = true;
    document.getElementById('open-order-summary').hidden = true;
    document.getElementById('menu-content').innerHTML = content;
    document.getElementById('menu-note').textContent = '';
    return;
  }
  const dialog = document.getElementById('order-summary');
  const summaryItems = document.getElementById('order-summary-items');
  const customerDetails = document.getElementById('order-customer-details');
  const actions = dialog.querySelector('.order-summary-actions');
  const status = document.getElementById('order-action-status');
  const confirmation = document.getElementById('order-confirmation');
  dialog.querySelector('.order-dialog-head').hidden = true;
  summaryItems.hidden = true;
  customerDetails.hidden = true;
  actions.hidden = true;
  status.hidden = true;
  confirmation.innerHTML = `${content}<button type="button" id="fallback-try-again" class="confirmation-secondary">Try Online Order Again</button>`;
  confirmation.hidden = false;
}

function showProximityRestriction(menu) {
  const radius = Math.round(Number(menu.proximity?.radius) || 0);
  document.querySelector('.menu-tools').hidden = true;
  document.getElementById('open-order-summary').hidden = true;
  document.getElementById('menu-content').innerHTML = `
    <section class="proximity-restriction" role="alert">
      <span class="proximity-icon" aria-hidden="true">⌖</span>
      <p class="eyebrow">Ordering location limit</p>
      <h2>You’re too far from Red Lantern Restaurant to order from this QR menu.</h2>
      <p>To place an order here, please be within <strong>${radius} metres</strong> of the restaurant.</p>
      <p class="proximity-help">Need help? Call us and we’ll be happy to take your order.</p>
      ${proximityCallLink(menu)}
    </section>`;
  document.getElementById('menu-note').textContent = '';
}
function nextDirectOrderRequestId() {
  return `qr-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
function clearDirectOrderRequestId() {
  directOrderRequestId = '';
  sessionStorage.removeItem(directOrderRequestKey);
}

function syncOrderVisibleHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--order-visible-height', `${Math.round(height)}px`);
}

syncOrderVisibleHeight();
window.visualViewport?.addEventListener('resize', syncOrderVisibleHeight);
window.addEventListener('resize', syncOrderVisibleHeight);

try {
  orderSelections = JSON.parse(sessionStorage.getItem(orderStorageKey) || '{}');
} catch {
  orderSelections = {};
}

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const slug = (value) =>
  String(value || 'menu')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function displayName(value) {
  return String(value || '')
    .replace(/[.…·]{2,}/g, ' ')
    .replace(/\s+\d{2,5}(?:\.\d{1,2})?\s*\/?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayPrice(dish) {
  const explicit = String(dish.price || '').match(/(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)/i);
  const fromName = String(dish.name || '').match(/\s(\d{2,5}(?:\.\d{1,2})?)\s*\/?\s*$/);
  const amount = explicit?.[1] || fromName?.[1];
  return amount ? `₹${amount}` : '';
}

function orderPriceWithStyle(item) {
  const price = String(item.price || '').trim();
  if (!item.style || !price) return price;
  const amount = price.match(/(?:₹|Rs\.?|INR)?\s*(\d{1,5}(?:\.\d{1,2})?)/i)?.[1];
  return amount ? `₹${Number(amount) + 10}` : price;
}

function styleLabel(item) {
  return item.style ? `${item.style} (+₹10)` : '';
}

function portionPriceHtml(dish) {
  const normalize = (value) => {
    const amount = String(value || '').match(/(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)/i)?.[1];
    return amount ? `₹${amount}` : '';
  };
  const half = normalize(dish.halfPrice);
  const full = normalize(dish.fullPrice);
  const withBone = normalize(dish.withBonePrice);
  const boneless = normalize(dish.bonelessPrice);
  const mlPrices = [
    ['30 ML', normalize(dish.price30ml)],
    ['60 ML', normalize(dish.price60ml)],
    ['90 ML', normalize(dish.price90ml)],
    ['180 ML', normalize(dish.price180ml)],
  ].filter(([, price]) => price);
  if (mlPrices.length)
    return `<span class="portion-prices ml-prices">${mlPrices.map(([label, price]) => `<span><small>${label}</small>${escapeHtml(price)}</span>`).join('')}</span>`;
  if (half || full || withBone || boneless)
    return `<span class="portion-prices">${half ? `<span><small>Half</small>${escapeHtml(half)}</span>` : ''}${full ? `<span><small>Full</small>${escapeHtml(full)}</span>` : ''}${withBone ? `<span><small>With Bone</small>${escapeHtml(withBone)}</span>` : ''}${boneless ? `<span><small>Boneless</small>${escapeHtml(boneless)}</span>` : ''}</span>`;
  const price = displayPrice(dish);
  return price ? `<span class="dish-price">${escapeHtml(price)}</span>` : '';
}

function dietaryTag(dish) {
  const tags = [];
  if (dish.type === 'beverage') tags.push('<span class="tag tag-drink">Beverage</span>');
  const text = `${dish.name || ''} ${dish.description || ''}`;
  const nonVeg =
    /\b(chicken|fish|prawn|shrimp|squid|calamari|crab|lobster|mutton|lamb|goat|egg|beef|pork|ham|bacon|sausage)\b/i.test(
      text
    );
  const categoryDietary = dietaryFromCategory(dish.category);
  if (dish.type !== 'beverage')
    tags.push(
      dish.dietary === 'nonveg' ||
        (!dish.dietary && (categoryDietary === 'nonveg' || (!categoryDietary && nonVeg)))
        ? '<span class="tag tag-nonveg">Non-Veg</span>'
        : '<span class="tag tag-veg">Veg</span>'
    );
  if (dish.bestSeller) tags.push('<span class="tag tag-featured">Best Seller</span>');
  if (dish.mustHave) tags.push('<span class="tag tag-must">Must Have</span>');
  return tags.join('');
}

function dietaryFromCategory(category) {
  const value = String(category || '').trim();
  if (/\bnon\s*[-/]?\s*veg\b|\bnonveg\b/i.test(value)) return 'nonveg';
  if (/\bveg(?:etarian)?\b/i.test(value)) return 'veg';
  return '';
}

function dietarySymbol(dish) {
  if (dish.type === 'beverage') return '';
  const inferredNonVeg =
    /\b(chicken|fish|prawn|shrimp|squid|calamari|crab|lobster|mutton|lamb|goat|egg|beef|pork|ham|bacon|sausage)\b/i.test(
      `${dish.name || ''} ${dish.description || ''}`
    );
  const kind =
    dish.dietary || dietaryFromCategory(dish.category) || (inferredNonVeg ? 'nonveg' : 'veg');
  return `<span class="dietary-symbol ${kind}" aria-label="${kind === 'nonveg' ? 'Non-Veg' : 'Veg'}"><i></i></span>`;
}

function registerOrderOptions(dish, category, index, showPrices) {
  const variants = [];
  if (dish.price30ml) variants.push({ portion: '30 ML', price: dish.price30ml });
  if (dish.price60ml) variants.push({ portion: '60 ML', price: dish.price60ml });
  if (dish.price90ml) variants.push({ portion: '90 ML', price: dish.price90ml });
  if (dish.price180ml) variants.push({ portion: '180 ML', price: dish.price180ml });
  if (!variants.length) {
    if (dish.halfPrice) variants.push({ portion: 'Half', price: dish.halfPrice });
    if (dish.fullPrice) variants.push({ portion: 'Full', price: dish.fullPrice });
    if (dish.withBonePrice) variants.push({ portion: 'With Bone', price: dish.withBonePrice });
    if (dish.bonelessPrice) variants.push({ portion: 'Boneless', price: dish.bonelessPrice });
  }
  if (!variants.length) variants.push({ portion: '', price: dish.price || displayPrice(dish) });
  return `<div class="order-pickers">${variants
    .map((variant) => {
      const styles = [{ label: 'Dry (default)', value: '' }];
      const hasGravyStyles =
        dish.gravyStyleAvailable || dish.gravyAvailable || dish.semiGravyAvailable;
      if (hasGravyStyles)
        styles.push(
          { label: 'Gravy', value: 'Gravy' },
          { label: 'Semi-Gravy', value: 'Semi-Gravy' }
        );
      const baseKey = `${category}|${displayName(dish.name)}|${variant.portion}`;
      const styleOptions = styles.map((style) => {
        const key = encodeURIComponent(`${baseKey}|${style.value || 'Dry'}`);
        orderCatalog.set(key, {
          key,
          name: displayName(dish.name),
          category,
          portion: variant.portion,
          style: style.value,
          price: variant.price || '',
          showPrices,
          gravyStyleAvailable: hasGravyStyles,
        });
        return { ...style, key };
      });
      const selected =
        styleOptions.find((style) => Number(orderSelections[style.key] || 0) > 0) ||
        styleOptions[0];
      const quantity = Number(orderSelections[selected.key] || 0);
      const customisation =
        styleOptions.length > 1
          ? `<fieldset class="order-customisation"><legend>Choose style <em>(optional · Dry by default)</em></legend>${styleOptions
              .slice(1)
              .map(
                (style) =>
                  `<label><input type="radio" name="menu-style-${index}-${slug(`${category}-${dish.name}-${variant.portion}`)}" data-order-style value="${style.key}" ${style.key === selected.key ? 'checked' : ''}><span>${escapeHtml(style.label)}</span></label>`
              )
              .join('')}</fieldset>`
          : '';
      return `<div class="order-picker" data-order-key="${selected.key}"><span>${variant.portion || 'Add'}</span><div class="quantity-control"><button type="button" data-order-action="minus" data-order-key="${selected.key}" aria-label="Remove one">−</button><strong data-order-quantity="${selected.key}">${quantity}</strong><button type="button" data-order-action="plus" data-order-key="${selected.key}" aria-label="Add one">+</button></div>${customisation}</div>`;
    })
    .join('')}</div>`;
}

function orderSummaryText() {
  const lines = ['*Red Lantern Order Selection For:*'];
  const tableLabel = scannedTableLabel();
  if (tableLabel) lines.push(`Table: ${tableLabel}`);
  if (orderIsBusinessCard) {
    lines.push(`Your Mobile Number: ${orderCustomerPhone || 'Not provided'}`);
    lines.push('');
  }
  Object.entries(orderSelections).forEach(([key, quantity]) => {
    const item = orderCatalog.get(key);
    if (!item || quantity <= 0) return;
    const price = orderPriceWithStyle(item);
    lines.push(
      `${quantity} × ${item.name}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` — ${styleLabel(item)}` : ''}${orderShowsPrices && price ? ` – ${price}${quantity > 1 ? ` each` : ''}` : ''}`
    );
  });
  if (orderIsBusinessCard) {
    lines.push('');
    lines.push('*Please confirm the availability and the final bill with the restaurant on call.*');
    lines.push('');
    lines.push('_If you do not receive a reply to your message, kindly call us._');
  } else {
    lines.push('Please confirm availability and the final bill with the waiter.');
  }
  return lines.join('\n');
}

function updateOrderUI() {
  const totalCount = Object.entries(orderSelections).reduce(
    (total, [key, quantity]) => total + (orderCatalog.has(key) ? Number(quantity || 0) : 0),
    0
  );
  document.querySelectorAll('[data-order-quantity]').forEach((element) => {
    const quantity = Number(orderSelections[element.dataset.orderQuantity] || 0);
    element.textContent = quantity;
    element.closest('.order-picker')?.classList.toggle('selected', quantity > 0);
  });
  sessionStorage.setItem(orderStorageKey, JSON.stringify(orderSelections));
  const fab = document.getElementById('open-order-summary');
  fab.hidden = totalCount === 0;
  document.getElementById('order-count').textContent = totalCount;
  renderOrderSummary();
}

function renderOrderSummary() {
  const container = document.getElementById('order-summary-items');
  const items = Object.entries(orderSelections).filter(
    ([key, quantity]) => quantity > 0 && orderCatalog.has(key)
  );
  container.innerHTML = items.length
    ? items
        .map(([key, quantity]) => {
          const item = orderCatalog.get(key);
          const styleChoices = item.gravyStyleAvailable
            ? ['Gravy', 'Semi-Gravy']
                .map((style) => {
                  const styleKey = encodeURIComponent(
                    `${item.category}|${item.name}|${item.portion}|${style}`
                  );
                  return `<label><input type="radio" name="summary-style-${key}" data-order-style value="${styleKey}" ${item.style === style ? 'checked' : ''}><span>${style} <em>+₹10</em></span></label>`;
                })
                .join('')
            : '';
          const customisation = styleChoices
            ? `<fieldset class="summary-style-options"><legend>Style <em>(optional · Dry by default)</em></legend>${styleChoices}</fieldset>`
            : '';
          return `<div class="summary-item"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.category, item.portion, styleLabel(item)].filter(Boolean).join(' · '))}</span>${customisation}</div><div class="summary-quantity"><button type="button" data-order-action="minus" data-order-key="${key}">−</button><b>${quantity}</b><button type="button" data-order-action="plus" data-order-key="${key}">+</button></div></div>`;
        })
        .join('')
    : '<p class="empty">No dishes selected yet.</p>';
  const customerDetails = document.getElementById('order-customer-details');
  const customerPhone = document.getElementById('order-customer-phone');
  customerDetails.hidden = !(orderIsBusinessCard || directOrdersEnabled);
  if (customerPhone && customerPhone.value !== orderCustomerPhone)
    customerPhone.value = orderCustomerPhone;
  const loyaltyPanel = document.getElementById('loyalty-panel');
  const redeemWrap = document.getElementById('loyalty-redeem-wrap');
  const redeemInput = document.getElementById('loyalty-redeem');
  if (loyaltyPanel)
    loyaltyPanel.hidden = !(
      directOrdersEnabled && String(orderCustomerPhone).replace(/\D/g, '').length >= 7
    );
  if (redeemWrap) redeemWrap.hidden = loyaltyPoints < 100;
  if (redeemInput) redeemInput.max = String(loyaltyPoints);
  const redeemPreview = document.getElementById('loyalty-redeem-preview');
  if (redeemPreview) {
    const value = Math.floor(Number(redeemInput?.value) || 0);
    redeemPreview.textContent =
      value >= 100
        ? `₹${Math.min(value, loyaltyPoints)} discount will be applied`
        : 'No points applied';
  }
  const whatsappTarget = orderWhatsAppNumber
    ? `https://wa.me/${orderWhatsAppNumber}`
    : 'https://wa.me/';
  document.getElementById('share-whatsapp').href =
    `${whatsappTarget}?text=${encodeURIComponent(orderSummaryText())}`;
}

async function loadLoyaltyPoints() {
  const phone = String(orderCustomerPhone).replace(/\D/g, '');
  const panel = document.getElementById('loyalty-panel');
  const balance = document.getElementById('loyalty-balance');
  if (!directOrdersEnabled || phone.length < 7) {
    loyaltyPoints = 0;
    if (panel) panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = false;
  if (balance) balance.textContent = 'Checking points…';
  try {
    const response = await fetch('/api/loyalty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error();
    loyaltyPoints = Number(data.points || 0);
    if (balance)
      balance.textContent =
        loyaltyPoints >= 100
          ? `${loyaltyPoints} points = ₹${loyaltyPoints} available`
          : `${loyaltyPoints} points · collect ${100 - loyaltyPoints} more to redeem`;
    renderOrderSummary();
  } catch {
    loyaltyPoints = 0;
    if (balance) balance.textContent = 'Points are unavailable right now.';
  }
}

function changeOrderQuantity(key, change) {
  orderSelections[key] = Math.max(0, Number(orderSelections[key] || 0) + change);
  if (!orderSelections[key]) delete orderSelections[key];
  updateOrderUI();
}

function changeOrderStyle(control) {
  const picker = control.closest('.order-picker');
  const previousKey =
    picker?.dataset.orderKey ||
    control.closest('.summary-item')?.querySelector('[data-order-action]')?.dataset.orderKey;
  const nextKey = control.value;
  if (!previousKey || !nextKey || previousKey === nextKey) return;
  const quantity = Number(orderSelections[previousKey] || 0);
  if (quantity) {
    orderSelections[nextKey] = Number(orderSelections[nextKey] || 0) + quantity;
    delete orderSelections[previousKey];
  }
  if (picker) {
    picker.dataset.orderKey = nextKey;
    picker.querySelectorAll('[data-order-key]').forEach((element) => {
      element.dataset.orderKey = nextKey;
    });
    const quantityLabel = picker.querySelector('[data-order-quantity]');
    if (quantityLabel) quantityLabel.dataset.orderQuantity = nextKey;
  }
  updateOrderUI();
}

function setupOrderShortlist() {
  const dialog = document.getElementById('order-summary');
  const summaryItems = document.getElementById('order-summary-items');
  const customerDetails = document.getElementById('order-customer-details');
  const actions = dialog.querySelector('.order-summary-actions');
  const confirmation = document.getElementById('order-confirmation');
  const confirmationTemplate = confirmation.innerHTML;
  const resetOrderDialog = () => {
    confirmation.innerHTML = confirmationTemplate;
    confirmation.hidden = true;
    dialog.querySelector('.order-dialog-head').hidden = false;
    summaryItems.hidden = false;
    customerDetails.hidden = !(orderIsBusinessCard || directOrdersEnabled);
    actions.hidden = false;
    document.getElementById('order-action-status').hidden = false;
  };
  dialog.insertBefore(customerDetails, summaryItems);
  dialog.insertBefore(actions, summaryItems);
  const handleQuantity = (event) => {
    const button = event.target.closest('[data-order-action]');
    if (!button) return;
    changeOrderQuantity(button.dataset.orderKey, button.dataset.orderAction === 'plus' ? 1 : -1);
  };
  document.getElementById('menu-content').addEventListener('click', handleQuantity);
  document.getElementById('menu-content').addEventListener('change', (event) => {
    const radio = event.target.closest('[data-order-style]');
    if (radio) changeOrderStyle(radio);
  });
  document.getElementById('order-summary-items').addEventListener('change', (event) => {
    const radio = event.target.closest('[data-order-style]');
    if (radio) changeOrderStyle(radio);
  });
  document.getElementById('order-summary-items').addEventListener('click', handleQuantity);
  document.getElementById('open-order-summary').addEventListener('click', () => {
    resetOrderDialog();
    syncOrderVisibleHeight();
    dialog.showModal();
    dialog.scrollTop = 0;
  });
  document.getElementById('close-order-summary').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.getElementById('clear-order').addEventListener('click', () => {
    orderSelections = {};
    updateOrderUI();
  });
  document.getElementById('order-customer-phone').addEventListener('input', (event) => {
    orderCustomerPhone = event.target.value.trim();
    localStorage.setItem('red-lantern-order-phone', orderCustomerPhone);
    renderOrderSummary();
    clearTimeout(loyaltyLookupTimer);
    loyaltyLookupTimer = setTimeout(loadLoyaltyPoints, 300);
  });
  document.getElementById('loyalty-redeem').addEventListener('input', (event) => {
    const value = Math.max(0, Math.floor(Number(event.target.value) || 0));
    event.target.value = String(value >= 100 ? Math.min(value, loyaltyPoints) : 0);
    renderOrderSummary();
  });
  document.getElementById('copy-order')?.addEventListener('click', async () => {
    const status = document.getElementById('order-action-status');
    try {
      await navigator.clipboard.writeText(orderSummaryText());
      status.textContent = 'Order summary copied.';
    } catch {
      status.textContent = 'Copy is unavailable. Use WhatsApp sharing instead.';
    }
  });
  document.getElementById('place-direct-order').addEventListener('click', async () => {
    const status = document.getElementById('order-action-status');
    const phone = document.getElementById('order-customer-phone').value.trim();
    const items = Object.entries(orderSelections)
      .filter(([, quantity]) => quantity > 0)
      .map(([key, quantity]) => ({ ...orderCatalog.get(key), quantity }));
    if (!phone || phone.replace(/\D/g, '').length < 7) {
      status.textContent = 'Please enter a valid mobile number to place a direct order.';
      return;
    }
    if (!navigator.onLine) {
      showOrderOutageFallback();
      return;
    }
    const button = document.getElementById('place-direct-order');
    button.disabled = true;
    status.textContent = 'Placing your order…';
    try {
      const loyaltyInput = document.getElementById('loyalty-redeem');
      const loyaltyPointsToUse = Math.floor(Number(loyaltyInput?.value) || 0);
      directOrderRequestId ||= nextDirectOrderRequestId();
      sessionStorage.setItem(directOrderRequestKey, directOrderRequestId);
      const response = await fetch('/api/direct-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Direct-Order-Id': directOrderRequestId },
        body: JSON.stringify({
          clientRequestId: directOrderRequestId,
          mode: params.get('mode'),
          expires,
          signature: params.get('signature'),
          customerPhone: phone,
          customerName: document.getElementById('order-customer-name').value.trim(),
          specialRequest: document.getElementById('order-special-request').value.trim(),
          fulfillmentType: document.getElementById('order-fulfillment-type')?.value,
          proximity: proximityProof,
          loyaltyPoints: loyaltyPointsToUse,
          items,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(result.error || 'Unable to place the order.');
        error.status = response.status;
        throw error;
      }
      orderSelections = {};
      clearDirectOrderRequestId();
      loyaltyPoints = Math.max(0, loyaltyPoints - loyaltyPointsToUse);
      updateOrderUI();
      document.getElementById('confirmation-order-number').textContent =
        `#${result.orderNumber || '—'}`;
      document.getElementById('view-order-status').href = result.trackingUrl || '#';
      document.getElementById('confirmation-copy').textContent = result.autoAccepted
        ? 'Your order has been accepted. Follow the live status here as it is prepared and marked ready.'
        : 'Our counter team will confirm your order shortly. Follow the live status here for acceptance, preparation, and ready updates.';
      dialog.querySelector('.order-dialog-head').hidden = true;
      summaryItems.hidden = true;
      customerDetails.hidden = true;
      actions.hidden = true;
      status.hidden = true;
      confirmation.hidden = false;
    } catch (error) {
      if (!error.status || error.status >= 500 || error.status === 429) {
        showOrderOutageFallback();
      } else {
        status.textContent = error.message || 'Unable to place the order. Please call us.';
      }
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('place-another-order').addEventListener('click', () => {
    clearDirectOrderRequestId();
    resetOrderDialog();
    renderOrderSummary();
  });
  confirmation.addEventListener('click', (event) => {
    if (event.target.id !== 'fallback-try-again') return;
    resetOrderDialog();
    renderOrderSummary();
  });
  updateOrderUI();
}

function configureOrderActions(menu) {
  const isCard = menu.mode === 'card';
  orderIsBusinessCard = isCard;
  const fulfillmentType = document.getElementById('order-fulfillment-type');
  const deliveryEnabled = menu.deliveryEnabled !== false;
  if (fulfillmentType) {
    fulfillmentType.innerHTML = `${deliveryEnabled ? '<option value="delivery">Delivery</option>' : ''}<option value="pickup">Pick Up</option>`;
    fulfillmentType.value = isCard && deliveryEnabled ? 'delivery' : 'pickup';
  }
  document.body.classList.toggle('card-menu-mode', isCard);
  const whatsapp = document.getElementById('share-whatsapp');
  directOrdersEnabled = menu.directOrdersEnabled === true;
  document.getElementById('place-direct-order').hidden = !directOrdersEnabled;
  whatsapp.hidden = !isCard;
  const call = document.getElementById('call-to-order');
  const phone = String(menu.cardOrderPhone || '').trim();
  const phoneDigits = phone.replace(/\D/g, '');
  const dialNumber = `${phone.startsWith('+') ? '+' : ''}${phoneDigits}`;
  orderWhatsAppNumber = phoneDigits.length >= 7 ? phoneDigits : '';
  const showCall = isCard && menu.cardCallEnabled && phoneDigits.length >= 7;
  call.hidden = !showCall;
  call.href = showCall ? `tel:${dialNumber}` : '#';
  if (directOrdersEnabled && String(orderCustomerPhone).replace(/\D/g, '').length >= 7)
    loadLoyaltyPoints();
}

function setupMenuControls() {
  const input = document.getElementById('menu-search');
  const sections = [...document.querySelectorAll('.category')];
  const typeNav = document.getElementById('menu-type-nav');
  const categoryNav = document.getElementById('category-nav');
  const availableTypes = [...new Set(sections.map((section) => section.dataset.menuType))];
  let activeType = availableTypes[0] || 'food';

  const highlightSection = (section) => {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      sections.forEach((item) => item.classList.remove('category-selected'));
      section.classList.add('category-selected');
    }, 320);
  };

  const renderCategoryNav = () => {
    const activeSections = sections.filter((section) => section.dataset.menuType === activeType);
    categoryNav.innerHTML = activeSections
      .map(
        (section, index) =>
          `<button type="button" class="${index === 0 ? 'active' : ''}" data-target="${section.id}">${escapeHtml(section.dataset.category)}</button>`
      )
      .join('');
  };

  const filterMenu = () => {
    const query = input.value.trim().toLowerCase();
    let visibleItems = 0;
    sections.forEach((section) => {
      const inActiveMenu = section.dataset.menuType === activeType;
      let sectionItems = 0;
      section.querySelectorAll('.dish').forEach((dish) => {
        const visible = inActiveMenu && (!query || dish.dataset.search.includes(query));
        dish.hidden = !visible;
        if (visible) sectionItems += 1;
      });
      section.hidden = !inActiveMenu || sectionItems === 0;
      visibleItems += sectionItems;
    });
    let empty = document.getElementById('search-empty');
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'search-empty';
      empty.className = 'empty';
      empty.textContent = 'No menu items match your search.';
      document.getElementById('menu-content').appendChild(empty);
    }
    empty.hidden = visibleItems > 0;
  };
  input.addEventListener('input', filterMenu);
  typeNav.innerHTML = availableTypes
    .map(
      (type, index) =>
        `<button type="button" class="${index === 0 ? 'active' : ''}" data-menu-type="${type}">${type === 'bar' ? 'Bar Menu' : 'Food Menu'}</button>`
    )
    .join('');
  typeNav.hidden = availableTypes.length < 2;
  typeNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-menu-type]');
    if (!button || button.dataset.menuType === activeType) return;
    activeType = button.dataset.menuType;
    typeNav
      .querySelectorAll('button')
      .forEach((item) => item.classList.toggle('active', item === button));
    renderCategoryNav();
    filterMenu();
    const firstSection = sections.find(
      (section) => section.dataset.menuType === activeType && !section.hidden
    );
    sections.forEach((section) => section.classList.remove('category-selected'));
    if (firstSection) firstSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  categoryNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target]');
    if (!button) return;
    categoryNav.querySelectorAll('button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const section = document.getElementById(button.dataset.target);
    if (!section) return;
    highlightSection(section);
  });
  renderCategoryNav();
  filterMenu();
}

function updateTimer() {
  const remaining = expires - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return window.location.replace(fallbackUrl);
  const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  document.getElementById('time-left').textContent =
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setupPrivacyDeterrents() {
  const shield = document.getElementById('privacy-shield');
  const watermark = document.getElementById('session-watermark');
  watermark.textContent = `RED LANTERN · ${(params.get('signature') || 'PROTECTED').slice(-8).toUpperCase()}`;
  const showShield = () => shield.classList.add('visible');
  const hideShield = () => shield.classList.remove('visible');
  document.addEventListener('visibilitychange', () =>
    document.hidden ? showShield() : window.setTimeout(hideShield, 180)
  );
  window.addEventListener('blur', showShield);
  window.addEventListener('focus', () => window.setTimeout(hideShield, 180));
  window.addEventListener('beforeprint', showShield);
  window.addEventListener('afterprint', hideShield);
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'PrintScreen' ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p')
    ) {
      event.preventDefault();
      showShield();
      navigator.clipboard?.writeText('').catch(() => {});
      window.setTimeout(hideShield, 1400);
    }
  });
}

async function loadMenu() {
  try {
    const response = await fetch(`/api/air-menu?${params.toString()}`, { cache: 'no-store' });
    const menu = await response.json();
    if (!response.ok || menu.expired) return window.location.replace(menu.redirect || fallbackUrl);
    activeMenu = menu;
    sessionStorage.setItem(menuCacheKey, JSON.stringify(menu));

    document.getElementById('menu-kind').textContent =
      `${menu.tableLabel || (menu.mode === 'card' ? 'Food menu' : 'Complete table menu')} · ${menu.pageTitle}`;
    const tableIdentity = document.getElementById('table-identity');
    tableIdentity.hidden = !menu.tableLabel;
    tableIdentity.textContent = menu.tableLabel
      ? `Table No. ${menu.tableNumber} · ${menu.tableArea}`
      : '';
    document.getElementById('menu-title').textContent = 'Red Lantern';
    document.getElementById('menu-subtitle').textContent = menu.pageSubtitle;
    document.getElementById('menu-note').textContent = menu.note;
    if (menu.closed) {
      document.querySelector('.menu-tools').hidden = true;
      document.getElementById('menu-content').innerHTML =
        `<section class="restaurant-closed"><span class="closed-icon" aria-hidden="true">◷</span><p class="eyebrow">Restaurant status</p><h2>${escapeHtml(menu.message || 'The restaurant is currently closed.')}</h2><p>${escapeHtml(menu.reopensAt || 'Please check back soon for our reopening time.')}</p></section>`;
      document.getElementById('menu-note').textContent = '';
      return;
    }
    if (menu.proximity?.required) {
      try {
        await verifyProximity(menu.proximity);
      } catch (error) {
        if (error.code === 'outside-proximity-radius') {
          showProximityRestriction(menu);
          return;
        }
        document.getElementById('menu-note').textContent =
          'Location permission is required to show this ordering menu.';
        document.getElementById('menu-content').innerHTML =
          '<p class="empty">Please allow location access and scan the QR code again.</p>';
        document.querySelector('.menu-tools').hidden = true;
        return;
      }
    }
    configureOrderActions(menu);
    orderCatalog.clear();
    orderShowsPrices = menu.showPrices;

    const groups = menu.dishes.reduce((all, dish) => {
      const menuType = dish.isBar ? 'bar' : 'food';
      const category = dish.category || 'Menu';
      ((all[menuType] ||= {})[category] ||= []).push(dish);
      return all;
    }, {});
    const entries = ['food', 'bar'].flatMap((menuType) =>
      Object.entries(groups[menuType] || {}).map(([category, dishes]) => ({
        menuType,
        category,
        dishes,
      }))
    );
    document.getElementById('menu-content').innerHTML = entries.length
      ? entries
          .map(
            ({ menuType, category, dishes }) => `
      <section class="category" id="${menuType}-${slug(category)}" data-menu-type="${menuType}" data-category="${escapeHtml(category)}">
        <h2>${escapeHtml(category)}</h2>
        <div class="dish-grid">${dishes
          .map(
            (
              dish,
              index
            ) => `<article class="dish" data-search="${escapeHtml(`${displayName(dish.name)} ${dish.category} ${dish.description || ''}`.toLowerCase())}">
          <div class="dish-head"><h3>${dietarySymbol(dish)}<span>${escapeHtml(displayName(dish.name))}</span></h3>${menu.showPrices ? portionPriceHtml(dish) : ''}</div>
          ${dish.description ? `<p class="dish-description">${escapeHtml(dish.description)}</p>` : ''}
          <div class="tags">${dietaryTag(dish)}</div>
          ${registerOrderOptions(dish, category, index, menu.showPrices)}
        </article>`
          )
          .join('')}</div>
      </section>`
          )
          .join('')
      : '<p class="empty">The menu is being updated. Please ask our team for today’s selections.</p>';
    if (entries.length) {
      setupMenuControls();
      updateOrderUI();
    }
  } catch (error) {
    console.error('Air Menu failed to load; showing the saved QR-order fallback:', error);
    try {
      activeMenu = JSON.parse(sessionStorage.getItem(menuCacheKey) || 'null');
    } catch {
      activeMenu = null;
    }
    if (activeMenu) {
      document.getElementById('table-identity').hidden = !activeMenu.tableLabel;
      document.getElementById('table-identity').textContent = activeMenu.tableLabel
        ? `Table No. ${activeMenu.tableNumber} · ${activeMenu.tableArea}`
        : '';
      showOrderOutageFallback(activeMenu, { fullScreen: true });
      return;
    }
    window.location.replace(fallbackUrl);
  }
}

updateTimer();
setInterval(updateTimer, 1000);
setupPrivacyDeterrents();
setupOrderShortlist();
loadMenu();

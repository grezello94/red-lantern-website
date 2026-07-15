const params = new URLSearchParams(window.location.search);
const fallbackUrl = 'https://www.redlanternrestaurant.in/menu';
const expires = Number(params.get('expires'));
const orderStorageKey = `red-lantern-order:${params.get('signature') || expires}`;
const orderCatalog = new Map();
let orderSelections = {};
let orderShowsPrices = false;

try { orderSelections = JSON.parse(sessionStorage.getItem(orderStorageKey) || '{}'); } catch { orderSelections = {}; }

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const slug = (value) => String(value || 'menu').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

function portionPriceHtml(dish) {
  const normalize = (value) => {
    const amount = String(value || '').match(/(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)/i)?.[1];
    return amount ? `₹${amount}` : '';
  };
  const half = normalize(dish.halfPrice);
  const full = normalize(dish.fullPrice);
  if (half || full) return `<span class="portion-prices">${half ? `<span><small>Half</small>${escapeHtml(half)}</span>` : ''}${full ? `<span><small>Full</small>${escapeHtml(full)}</span>` : ''}</span>`;
  const price = displayPrice(dish);
  return price ? `<span class="dish-price">${escapeHtml(price)}</span>` : '';
}

function dietaryTag(dish) {
  const tags = [];
  if (dish.type === 'beverage') tags.push('<span class="tag tag-drink">Beverage</span>');
  const text = `${dish.name || ''} ${dish.description || ''}`;
  const nonVeg = /\b(chicken|fish|prawn|shrimp|squid|calamari|crab|lobster|mutton|lamb|goat|egg|beef|pork|ham|bacon|sausage)\b/i.test(text);
  if (dish.type !== 'beverage') tags.push((dish.dietary === 'nonveg' || (!dish.dietary && nonVeg)) ? '<span class="tag tag-nonveg">Non-Veg</span>' : '<span class="tag tag-veg">Veg</span>');
  if (dish.bestSeller) tags.push('<span class="tag tag-featured">Best Seller</span>');
  if (dish.mustHave) tags.push('<span class="tag tag-must">Must Have</span>');
  return tags.join('');
}

function dietarySymbol(dish) {
  if (dish.type === 'beverage') return '';
  const inferredNonVeg = /\b(chicken|fish|prawn|shrimp|squid|calamari|crab|lobster|mutton|lamb|goat|egg|beef|pork|ham|bacon|sausage)\b/i.test(`${dish.name || ''} ${dish.description || ''}`);
  const kind = dish.dietary || (inferredNonVeg ? 'nonveg' : 'veg');
  return `<span class="dietary-symbol ${kind}" aria-label="${kind === 'nonveg' ? 'Non-Veg' : 'Veg'}"><i></i></span>`;
}

function numericPrice(value) {
  const amount = String(value || '').match(/(\d{1,6}(?:\.\d{1,2})?)/)?.[1];
  return amount ? Number(amount) : 0;
}

function registerOrderOptions(dish, category, index, showPrices) {
  const variants = [];
  if (dish.halfPrice) variants.push({ portion: 'Half', price: dish.halfPrice });
  if (dish.fullPrice) variants.push({ portion: 'Full', price: dish.fullPrice });
  if (!variants.length) variants.push({ portion: '', price: dish.price || displayPrice(dish) });
  return `<div class="order-pickers">${variants.map((variant) => {
    const key = encodeURIComponent(`${category}|${displayName(dish.name)}|${variant.portion}`);
    orderCatalog.set(key, { key, name: displayName(dish.name), category, portion: variant.portion, price: variant.price || '', showPrices });
    const quantity = Number(orderSelections[key] || 0);
    return `<div class="order-picker"><span>${variant.portion || 'Add'}</span><div class="quantity-control"><button type="button" data-order-action="minus" data-order-key="${key}" aria-label="Remove one">−</button><strong data-order-quantity="${key}">${quantity}</strong><button type="button" data-order-action="plus" data-order-key="${key}" aria-label="Add one">+</button></div></div>`;
  }).join('')}</div>`;
}

function orderSummaryText() {
  const lines = ['Red Lantern – Order Selection'];
  let total = 0;
  Object.entries(orderSelections).forEach(([key, quantity]) => {
    const item = orderCatalog.get(key);
    if (!item || quantity <= 0) return;
    const amount = numericPrice(item.price) * quantity;
    total += amount;
    lines.push(`${quantity} × ${item.name}${item.portion ? ` (${item.portion})` : ''}${orderShowsPrices && item.price ? ` – ${item.price}${quantity > 1 ? ` each` : ''}` : ''}`);
  });
  if (orderShowsPrices && total) lines.push(`Estimated total: ₹${total}`);
  lines.push('Please confirm availability and the final bill with the waiter.');
  return lines.join('\n');
}

function updateOrderUI() {
  let totalCount = 0;
  document.querySelectorAll('[data-order-quantity]').forEach((element) => {
    const quantity = Number(orderSelections[element.dataset.orderQuantity] || 0);
    element.textContent = quantity;
    element.closest('.order-picker')?.classList.toggle('selected', quantity > 0);
    totalCount += quantity;
  });
  sessionStorage.setItem(orderStorageKey, JSON.stringify(orderSelections));
  const fab = document.getElementById('open-order-summary');
  fab.hidden = totalCount === 0;
  document.getElementById('order-count').textContent = totalCount;
  renderOrderSummary();
}

function renderOrderSummary() {
  const container = document.getElementById('order-summary-items');
  const items = Object.entries(orderSelections).filter(([key, quantity]) => quantity > 0 && orderCatalog.has(key));
  container.innerHTML = items.length ? items.map(([key, quantity]) => {
    const item = orderCatalog.get(key);
    return `<div class="summary-item"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.category, item.portion].filter(Boolean).join(' · '))}</span></div><div class="summary-quantity"><button type="button" data-order-action="minus" data-order-key="${key}">−</button><b>${quantity}</b><button type="button" data-order-action="plus" data-order-key="${key}">+</button></div></div>`;
  }).join('') : '<p class="empty">No dishes selected yet.</p>';
  document.getElementById('share-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(orderSummaryText())}`;
}

function changeOrderQuantity(key, change) {
  orderSelections[key] = Math.max(0, Number(orderSelections[key] || 0) + change);
  if (!orderSelections[key]) delete orderSelections[key];
  updateOrderUI();
}

function setupOrderShortlist() {
  const dialog = document.getElementById('order-summary');
  const handleQuantity = (event) => {
    const button = event.target.closest('[data-order-action]');
    if (!button) return;
    changeOrderQuantity(button.dataset.orderKey, button.dataset.orderAction === 'plus' ? 1 : -1);
  };
  document.getElementById('menu-content').addEventListener('click', handleQuantity);
  document.getElementById('order-summary-items').addEventListener('click', handleQuantity);
  document.getElementById('open-order-summary').addEventListener('click', () => dialog.showModal());
  document.getElementById('close-order-summary').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.getElementById('clear-order').addEventListener('click', () => { orderSelections = {}; updateOrderUI(); });
  document.getElementById('copy-order').addEventListener('click', async () => {
    const status = document.getElementById('order-action-status');
    try {
      await navigator.clipboard.writeText(orderSummaryText());
      status.textContent = 'Order summary copied.';
    } catch { status.textContent = 'Copy is unavailable. Use WhatsApp sharing instead.'; }
  });
  updateOrderUI();
}

function configureOrderActions(menu) {
  const isCard = menu.mode === 'card';
  document.body.classList.toggle('card-menu-mode', isCard);
  const whatsapp = document.getElementById('share-whatsapp');
  whatsapp.hidden = !isCard;
  const call = document.getElementById('call-to-order');
  const phone = String(menu.cardOrderPhone || '').trim();
  const dialNumber = `${phone.startsWith('+') ? '+' : ''}${phone.replace(/\D/g, '')}`;
  const showCall = isCard && menu.cardCallEnabled && dialNumber.replace(/\D/g, '').length >= 7;
  call.hidden = !showCall;
  call.href = showCall ? `tel:${dialNumber}` : '#';
}

function setupMenuControls() {
  const input = document.getElementById('menu-search');
  const sections = [...document.querySelectorAll('.category')];
  const buttons = [...document.querySelectorAll('.category-nav button')];
  const filterMenu = () => {
    const query = input.value.trim().toLowerCase();
    let visibleItems = 0;
    sections.forEach((section) => {
      let sectionItems = 0;
      section.querySelectorAll('.dish').forEach((dish) => {
        const visible = !query || dish.dataset.search.includes(query);
        dish.hidden = !visible;
        if (visible) sectionItems += 1;
      });
      section.hidden = sectionItems === 0;
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
  buttons.forEach((button) => button.addEventListener('click', () => {
    buttons.forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const section = document.getElementById(button.dataset.target);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      sections.forEach((item) => item.classList.remove('category-highlight'));
      section.classList.remove('category-highlight');
      void section.offsetWidth;
      section.classList.add('category-highlight');
      window.setTimeout(() => section.classList.remove('category-highlight'), 2400);
    }, 320);
  }));
}

function updateTimer() {
  const remaining = expires - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return window.location.replace(fallbackUrl);
  const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  document.getElementById('time-left').textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setupPrivacyDeterrents() {
  const shield = document.getElementById('privacy-shield');
  const watermark = document.getElementById('session-watermark');
  watermark.textContent = `RED LANTERN · ${(params.get('signature') || 'PROTECTED').slice(-8).toUpperCase()}`;
  const showShield = () => shield.classList.add('visible');
  const hideShield = () => shield.classList.remove('visible');
  document.addEventListener('visibilitychange', () => document.hidden ? showShield() : window.setTimeout(hideShield, 180));
  window.addEventListener('blur', showShield);
  window.addEventListener('focus', () => window.setTimeout(hideShield, 180));
  window.addEventListener('beforeprint', showShield);
  window.addEventListener('afterprint', hideShield);
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'PrintScreen' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p')) {
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

    document.getElementById('menu-kind').textContent = `${menu.mode === 'card' ? 'Food menu' : 'Complete table menu'} · ${menu.pageTitle}`;
    document.getElementById('menu-title').textContent = 'Red Lantern';
    document.getElementById('menu-subtitle').textContent = menu.pageSubtitle;
    document.getElementById('menu-note').textContent = menu.note;
    configureOrderActions(menu);
    orderCatalog.clear();
    orderShowsPrices = menu.showPrices;

    const groups = menu.dishes.reduce((all, dish) => {
      const category = dish.category || 'Menu';
      (all[category] ||= []).push(dish);
      return all;
    }, {});
    const entries = Object.entries(groups);
    document.getElementById('category-nav').innerHTML = entries.map(([category], index) =>
      `<button type="button" class="${index === 0 ? 'active' : ''}" data-target="${slug(category)}">${escapeHtml(category)}</button>`).join('');
    document.getElementById('menu-content').innerHTML = entries.length ? entries.map(([category, dishes]) => `
      <section class="category" id="${slug(category)}">
        <h2>${escapeHtml(category)}</h2>
        <div class="dish-grid">${dishes.map((dish, index) => `<article class="dish" data-search="${escapeHtml(`${displayName(dish.name)} ${dish.category} ${dish.description || ''}`.toLowerCase())}">
          <div class="dish-head"><h3>${dietarySymbol(dish)}<span>${escapeHtml(displayName(dish.name))}</span></h3>${menu.showPrices ? portionPriceHtml(dish) : ''}</div>
          ${dish.description ? `<p class="dish-description">${escapeHtml(dish.description)}</p>` : ''}
          <div class="tags">${dietaryTag(dish)}</div>
          ${registerOrderOptions(dish, category, index, menu.showPrices)}
        </article>`).join('')}</div>
      </section>`).join('') : '<p class="empty">The menu is being updated. Please ask our team for today’s selections.</p>';
    if (entries.length) { setupMenuControls(); updateOrderUI(); }
  } catch {
    document.getElementById('menu-content').innerHTML = '<p class="empty">We could not load the menu. Please try scanning the QR code again.</p>';
  }
}

updateTimer();
setInterval(updateTimer, 1000);
setupPrivacyDeterrents();
setupOrderShortlist();
loadMenu();

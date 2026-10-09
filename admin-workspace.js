/* Navigation and draft feedback for Admin. Existing editors own their data and API calls. */
(() => {
  'use strict';
  const sidebar = document.getElementById('admin-sidebar');
  const navigation = document.getElementById('admin-navigation');
  const panels = [...document.querySelectorAll('.tab-content')];
  const items = [...document.querySelectorAll('.sidebar .nav-item')];
  if (!sidebar || !navigation) return;

  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
    menu: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    blogs: '<path d="M14 4H5v16h14v-9M12 12l8-8-3-3-8 8-1 4zM8 17h7"/>',
    contact: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 6 9 7 9-7"/>',
    footer: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 15h18M8 18h8"/>',
    'sales-dashboard': '<path d="M4 4v16h17M8 16v-5M13 16V7M18 16v-9"/>',
    'customer-insights':
      '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M19 20v-3a6 6 0 0 0-3-5"/>',
    'captain-app': '<rect x="7" y="2" width="10" height="20" rx="3"/><path d="M10 5h4M11 18h2"/>',
    'smart-kds':
      '<rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4m-5-9 3-3 3 3 4-5"/>',
    'air-menu': '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 9h6v6H9z"/>',
    'trusted-contacts': '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
    growth: '<path d="M4 19h16M6 15l4-4 4 2 6-8M15 5h5v5"/>',
    'qr-scans':
      '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h6v6h-6zM12 3v6M3 12h6M12 12h9M12 15v6"/>',
    logs: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h6"/>',
    'orders-errors': '<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',
    'database-health':
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  };
  const groups = new Map();
  let currentGroup = 'Website management';
  [...navigation.children].forEach((child) => {
    if (child.matches('.nav-category')) currentGroup = child.childNodes[0].textContent.trim();
    if (child.matches('.nav-item')) groups.set(child.dataset.target, currentGroup);
  });
  items.forEach((item) => {
    const label = document.createElement('span');
    label.className = 'admin-nav-label';
    label.textContent = item.textContent.trim();
    item.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'admin-nav-icon';
    icon.innerHTML = svg(icons[item.dataset.target.replace('tab-', '')] || icons.menu);
    item.append(icon, label);
    if (item.tagName !== 'A') {
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        item.click();
      });
    }
    item.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const visible = items.filter((entry) => !entry.hidden);
      const index = visible.indexOf(item);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? visible.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      event.preventDefault();
      visible[next]?.focus();
    });
  });

  const searchRow = document.createElement('div');
  searchRow.className = 'admin-sidebar-search';
  searchRow.innerHTML = `${svg('<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>')}<input type="search" id="admin-sidebar-search" placeholder="Find a section" aria-label="Search Admin sections" autocomplete="off"><button type="button" id="admin-sidebar-search-clear" aria-label="Clear section search" hidden>×</button>`;
  const empty = document.createElement('p');
  empty.id = 'admin-nav-empty';
  empty.textContent = 'No matching sections. Try another search.';
  empty.hidden = true;
  navigation.prepend(searchRow);
  navigation.append(empty);
  const search = searchRow.querySelector('input');
  const clearSearch = searchRow.querySelector('button');
  const filterNavigation = () => {
    const query = search.value.trim().toLowerCase();
    items.forEach((item) => {
      item.hidden = !item.textContent.toLowerCase().includes(query);
    });
    navigation.querySelectorAll('.nav-category').forEach((category) => {
      let next = category.nextElementSibling;
      let visible = false;
      while (next && !next.matches('.nav-category')) {
        if (next.matches('.nav-item') && !next.hidden) visible = true;
        next = next.nextElementSibling;
      }
      category.hidden = !visible;
    });
    clearSearch.hidden = !query;
    empty.hidden = items.some((item) => !item.hidden);
  };
  search.addEventListener('input', filterNavigation);
  clearSearch.addEventListener('click', () => {
    search.value = '';
    filterNavigation();
    search.focus();
  });
  document.addEventListener('click', (event) => {
    if (document.body.classList.contains('admin-nav-open') && !sidebar.contains(event.target))
      setAdminNavOpen(false);
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const jumpTo = (target, { focus = false } = {}) => {
    if (!target) return;
    const details = target.closest('details');
    if (details) details.open = true;
    target.scrollIntoView({
      behavior: reducedMotion.matches ? 'instant' : 'smooth',
      block: 'start',
    });
    if (focus) target.querySelector('button[type="submit"]')?.focus({ preventScroll: true });
  };
  const headingLabel = (heading) => {
    const copy = heading.cloneNode(true);
    copy.querySelectorAll('small, svg, i, [aria-hidden="true"]').forEach((child) => child.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };
  panels.forEach((panel) => {
    // Smart KDS already has navigation that controls its five independent subworkspaces.
    if (panel.id === 'tab-smart-kds' || panel.id === 'tab-captain-app') return;
    const sections = new Map();
    panel
      .querySelectorAll(
        '.card h2, .order-channels-card h2, .analytics-panel h2, .analytics-definitions h2'
      )
      .forEach((heading) => {
        if (heading.closest('[hidden], [style*="display: none"], [style*="display:none"]')) return;
        const section = heading.closest(
          '.card, .order-channels-card, .analytics-panel, .analytics-definitions'
        );
        if (!section || sections.has(section)) return;
        sections.set(section, headingLabel(heading));
      });
    if (sections.size < 2) return;
    const nav = document.createElement('nav');
    nav.className = 'admin-section-nav';
    nav.id = `${panel.id}-sections`;
    nav.setAttribute('aria-label', `${panel.querySelector('h1').textContent.trim()} sections`);
    [...sections].forEach(([section, name], index) => {
      section.id ||= `${panel.id}-section-${index + 1}`;
      section.classList.add('admin-section-anchor');
      const link = document.createElement('a');
      link.href = `#${section.id}`;
      link.dataset.adminSectionLink = section.id;
      const number = document.createElement('span');
      number.className = 'admin-section-number';
      number.textContent = String(index + 1).padStart(2, '0');
      link.append(number, document.createTextNode(name));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        jumpTo(section);
      });
      nav.append(link);
    });
    panel.querySelector(':scope > .header').after(nav);
  });

  // Each Captain workspace keeps its existing controls mounted so switching views preserves drafts.
  const captainPanel = document.getElementById('tab-captain-app');
  const captainViews = [
    {
      key: 'employees',
      label: 'Employees',
      card: document.getElementById('captain-admin-list')?.closest('.card'),
    },
    {
      key: 'settings',
      label: 'App settings',
      card: captainPanel?.querySelector('.captain-settings-card'),
    },
    {
      key: 'activity',
      label: 'Live activity',
      card: document.getElementById('captain-activity-list')?.closest('.card'),
    },
    {
      key: 'access',
      label: 'Access log',
      card: document.getElementById('employee-audit-list')?.closest('.card'),
    },
  ].filter((view) => view.card);
  let captainView = 'employees';
  try {
    const stored = sessionStorage.getItem('admin-captain-view');
    if (captainViews.some((view) => view.key === stored)) captainView = stored;
  } catch (_) {
    /* Views remain usable when browser storage is unavailable. */
  }
  const captainNav = document.createElement('nav');
  captainNav.className = 'admin-section-nav admin-captain-workspaces';
  captainNav.setAttribute('aria-label', 'Captain and employee workspaces');
  const selectCaptainView = (key, { scroll = true } = {}) => {
    if (!captainViews.some((view) => view.key === key)) return;
    captainView = key;
    captainViews.forEach((view) => {
      const active = view.key === key;
      view.card.hidden = !active;
      view.link.classList.toggle('is-active', active);
      if (active) view.link.setAttribute('aria-current', 'page');
      else view.link.removeAttribute('aria-current');
    });
    const add = document.getElementById('captain-add');
    if (add) add.hidden = key !== 'employees';
    try {
      sessionStorage.setItem('admin-captain-view', key);
    } catch (_) {}
    measureToolbar();
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  captainViews.forEach((view, index) => {
    view.card.id ||= `admin-captain-${view.key}`;
    view.card.classList.add('admin-captain-panel');
    const link = document.createElement('a');
    link.href = `#${view.card.id}`;
    link.dataset.captainWorkspace = view.key;
    link.setAttribute('aria-controls', view.card.id);
    link.innerHTML = `<span class="admin-section-number">${String(index + 1).padStart(2, '0')}</span>`;
    link.append(document.createTextNode(view.label));
    link.addEventListener('click', (event) => {
      event.preventDefault();
      selectCaptainView(view.key);
    });
    view.link = link;
    captainNav.append(link);
  });
  if (captainViews.length) {
    captainPanel.querySelector(':scope > .header').after(captainNav);
    const actions = captainPanel.querySelector('.captain-action-bar');
    const status = document.getElementById('captain-admin-status');
    if (actions && status) {
      const dock = document.createElement('div');
      dock.id = 'admin-captain-save-area';
      status.setAttribute('role', 'status');
      dock.append(status, actions);
      captainPanel.append(dock);
    }
    document.addEventListener('admin-captain-workspace', (event) => {
      selectCaptainView(event.detail?.target || 'employees');
    });
  }

  // Measure the real bars instead of letting fixed offsets hide a field on tablets or zoomed screens.
  const workspaceBar = document.getElementById('admin-workspace-bar');
  const sidebarBrand = sidebar.querySelector('.sidebar-brand');
  const measureToolbar = () => {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const sidebarHeight = mobile ? sidebarBrand.getBoundingClientRect().height : 0;
    const barHeight = workspaceBar.getBoundingClientRect().height;
    const toolbarBottom = Math.ceil(sidebarHeight + barHeight);
    const activeNav = document.querySelector(
      '.tab-content.active .admin-section-nav, .tab-content.active .smart-kds-admin-nav'
    );
    const navHeight = activeNav?.getBoundingClientRect().height || 0;
    document.body.style.setProperty('--admin-sidebar-height', `${Math.ceil(sidebarHeight)}px`);
    document.body.style.setProperty('--admin-toolbar-bottom', `${toolbarBottom + 10}px`);
    document.body.style.setProperty(
      '--admin-content-offset',
      `${Math.ceil(toolbarBottom + navHeight + 30)}px`
    );
  };
  const toolbarObserver = new ResizeObserver(measureToolbar);
  [
    workspaceBar,
    sidebarBrand,
    ...document.querySelectorAll('.admin-section-nav, .smart-kds-admin-nav'),
  ].forEach((element) => {
    if (element) toolbarObserver.observe(element);
  });
  window.addEventListener('resize', measureToolbar, { passive: true });
  selectCaptainView(captainView, { scroll: false });
  const syncWorkspace = () => {
    const panel = panels.find((entry) => entry.classList.contains('active'));
    if (!panel) return;
    document.getElementById('admin-workspace-title').textContent = panel
      .querySelector('h1')
      .textContent.trim();
    document.getElementById('admin-workspace-group').textContent =
      groups.get(panel.id) || 'Admin workspace';
    items.forEach((item) => {
      if (item.dataset.target === panel.id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    measureToolbar();
  };
  const syncSection = () => {
    const links = [
      ...document.querySelectorAll(
        '.tab-content.active .admin-section-nav:not(.admin-captain-workspaces) a'
      ),
    ];
    let current = links[0];
    const offset =
      parseFloat(document.body.style.getPropertyValue('--admin-content-offset')) || 180;
    links.forEach((link) => {
      if (
        document.getElementById(link.dataset.adminSectionLink).getBoundingClientRect().top <= offset
      )
        current = link;
    });
    links.forEach((link) => {
      link.classList.toggle('is-active', link === current);
      if (link === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  document.addEventListener('admin-tab-change', () => {
    syncWorkspace();
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(syncSection);
  });
  let scrollFrame = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        syncSection();
      });
    },
    { passive: true }
  );
  document.getElementById('admin-back-to-top').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  });
  document.querySelector('.admin-skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    const main = document.getElementById('admin-main');
    main.tabIndex = -1;
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  syncWorkspace();
  syncSection();
  // Tab hashes select a workspace; the browser's native anchor scroll would hide its header
  // underneath the fixed workspace bar on a direct link or refresh.
  window.addEventListener(
    'load',
    () => {
      if (window.location.hash.startsWith('#tab-'))
        window.scrollTo({ top: 0, behavior: 'instant' });
    },
    { once: true }
  );

  const formStates = new WeakMap();
  const forms = [...document.querySelectorAll('form[action^="/api/update-"]')];
  const drawState = (form, state) => {
    form.classList.toggle('has-admin-draft', state.dirty);
    const copy = form.querySelector('.admin-save-copy');
    if (form.dataset.adminContentState !== 'ready') {
      copy.querySelector('strong').textContent =
        form.dataset.adminContentState === 'error'
          ? 'Waiting for saved content'
          : 'Loading saved content…';
      copy.querySelector('small').textContent =
        'Editing and publishing become available after your saved content loads.';
      return;
    }
    copy.querySelector('strong').textContent = state.saving
      ? 'Saving changes…'
      : state.dirty
        ? 'Unsaved changes'
        : state.saved
          ? 'Changes published'
          : 'Ready to publish';
    copy.querySelector('small').textContent = state.saving
      ? 'Keep this page open while your changes are saved.'
      : state.dirty
        ? 'Your edits are kept here. Publish this section when ready.'
        : state.saved
          ? 'The submitted changes have been saved.'
          : 'Review your changes, then publish this section.';
  };
  const markDraft = (form) => {
    const state = formStates.get(form);
    if (!state) return;
    state.version += 1;
    state.dirty = true;
    drawState(form, state);
  };
  forms.forEach((form) => {
    const submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    const dock = document.createElement('div');
    dock.className = 'admin-save-bar';
    dock.innerHTML =
      '<div class="admin-save-copy" role="status" aria-live="polite"><strong></strong><small></small></div>';
    submit.before(dock);
    dock.append(submit);
    const state = { version: 0, savingVersion: 0, dirty: false, saving: false, saved: false };
    formStates.set(form, state);
    drawState(form, state);
    ['input', 'change'].forEach((type) =>
      form.addEventListener(type, (event) => {
        // These controls persist through their own endpoints, rather than the publish form.
        if (
          event.target.matches(
            '[data-dietary], [data-item-flag="gravyStyleAvailable"], [data-table-qr-area], [name="airProximityLocked"]'
          )
        )
          return;
        if (event.target.matches('input, select, textarea')) markDraft(form);
      })
    );
    form.addEventListener('click', (event) => {
      if (
        event.target.closest(
          '#add-dish-btn, #add-blog-btn, #add-review-btn, .remove-dish-btn, .remove-blog-btn, .remove-review-btn'
        )
      )
        markDraft(form);
    });
  });
  document.addEventListener('admin-content-draft', (event) => markDraft(event.detail?.form));
  document.addEventListener('admin-content-load-state', () => {
    forms.forEach((form) => {
      const state = formStates.get(form);
      if (state) drawState(form, state);
    });
  });
  document.addEventListener('admin-content-save-start', (event) => {
    const state = formStates.get(event.detail.form);
    if (!state) return;
    state.saving = true;
    state.savingVersion = state.version;
    drawState(event.detail.form, state);
  });
  document.addEventListener('admin-content-saved', (event) => {
    const state = formStates.get(event.detail.form);
    if (!state) return;
    state.saved = true;
    state.dirty = state.version !== state.savingVersion;
  });
  document.addEventListener('admin-content-save-finished', (event) => {
    const state = formStates.get(event.detail.form);
    if (!state) return;
    state.saving = false;
    drawState(event.detail.form, state);
  });

  document.querySelectorAll('[data-admin-workflow]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-admin-workflow]').forEach((step) => {
        const active = step === button;
        step.classList.toggle('is-active', active);
        if (active) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      });
      const target =
        button.dataset.adminWorkflow === 'import'
          ? document.querySelector('.air-import-grid')
          : button.dataset.adminWorkflow === 'review'
            ? document.querySelector('details.air-menu-sheet')
            : document.querySelector('#tab-air-menu .admin-save-bar');
      jumpTo(target, { focus: button.dataset.adminWorkflow === 'publish' });
    });
  });

  let fieldId = 0;
  const labelFields = (root) => {
    root.querySelectorAll('.form-group > label:not([for])').forEach((label) => {
      if (label.querySelector('input, select, textarea')) return;
      const fields = label.parentElement.querySelectorAll(
        'input:not([type="hidden"]), select, textarea'
      );
      if (
        fields.length !== 1 ||
        fields[0].hasAttribute('aria-label') ||
        fields[0].hasAttribute('aria-labelledby')
      )
        return;
      fields[0].id ||= `admin-field-${++fieldId}`;
      label.htmlFor = fields[0].id;
      const help = label.parentElement.querySelector('.help-text');
      if (help && !fields[0].hasAttribute('aria-describedby')) {
        help.id ||= `admin-field-help-${++fieldId}`;
        fields[0].setAttribute('aria-describedby', help.id);
      }
    });
    root.querySelectorAll('.switch-row input[type="checkbox"]').forEach((input) => {
      if (
        input.closest('label') ||
        input.labels?.length ||
        input.hasAttribute('aria-labelledby') ||
        input.hasAttribute('aria-label')
      )
        return;
      const title = input.closest('.switch-row').querySelector('strong');
      if (!title) return;
      title.id ||= `admin-switch-label-${++fieldId}`;
      input.setAttribute('aria-labelledby', title.id);
      input.setAttribute('role', 'switch');
    });
  };
  labelFields(document);
  let labelTimer = 0;
  new MutationObserver((records) => {
    if (!records.some((record) => record.addedNodes.length)) return;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => labelFields(document), 80);
  }).observe(document.getElementById('admin-main'), { childList: true, subtree: true });
})();

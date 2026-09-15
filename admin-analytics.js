(() => {
  const root = document.getElementById('tab-sales-dashboard');
  if (!root) return;

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]
    );
  const number = (value) => Number(value || 0);
  const whole = (value) => new Intl.NumberFormat('en-IN').format(Math.round(number(value)));
  const money = (value) =>
    new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(number(value));
  const dateTime = (value) =>
    value
      ? new Date(value).toLocaleString('en-IN', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kolkata',
        })
      : '—';
  const dayLabel = (value, includeYear = false) =>
    new Date(`${String(value).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      ...(includeYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const title = (value) =>
    String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const today = () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };

  const elements = {
    refresh: $('#analytics-refresh'),
    print: $('#analytics-print'),
    from: $('#analytics-from'),
    to: $('#analytics-to'),
    apply: $('#analytics-apply-range'),
    custom: $('#analytics-custom-range'),
    range: $('#analytics-range-label'),
    generated: $('#analytics-generated'),
    error: $('#analytics-error'),
    kpis: $('#analytics-kpis'),
    trend: $('#analytics-trend'),
    trendTotal: $('#analytics-trend-total'),
    channels: $('#analytics-channels'),
    payments: $('#analytics-payments'),
    kotStats: $('#analytics-kot-stats'),
    billStats: $('#analytics-bill-stats'),
    kotExceptions: $('#analytics-kot-exceptions'),
    billExceptions: $('#analytics-bill-exceptions'),
    kotExceptionCount: $('#analytics-kot-exception-count'),
    billExceptionCount: $('#analytics-bill-exception-count'),
    topItems: $('#analytics-top-items'),
    orders: $('#analytics-recent-orders'),
    definitions: $('#analytics-definitions'),
  };
  let preset = 'today';
  let loading = false;
  let loadedAt = 0;

  elements.from.value = today();
  elements.to.value = today();

  function emptyRow(columns, message) {
    return `<tr><td colspan="${columns}"><div class="analytics-empty">${escapeHtml(message)}</div></td></tr>`;
  }

  function changeMarkup(change, label) {
    if (change === null || change === undefined)
      return '<span class="analytics-change">No earlier-period baseline</span>';
    const value = number(change);
    const className = value > 0 ? 'positive' : value < 0 ? 'negative' : '';
    const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '•';
    return `<span class="analytics-change ${className}">${arrow} ${Math.abs(value).toFixed(1)}% ${escapeHtml(label)}</span>`;
  }

  function renderKpis(data) {
    const summary = data.summary || {};
    const comparison = data.comparison || {};
    const cards = [
      [
        'Net sales',
        money(summary.net_sales),
        'Completed bills only',
        'red',
        changeMarkup(comparison.sales, 'vs previous period'),
      ],
      [
        'Completed bills',
        whole(summary.completed_bills),
        'Paid and completed orders',
        'green',
        changeMarkup(comparison.bills, 'vs previous period'),
      ],
      [
        'Average bill',
        money(summary.average_bill),
        'Average completed bill value',
        'navy',
        changeMarkup(comparison.averageBill, 'vs previous period'),
      ],
      ['Total orders', whole(summary.total_orders), 'Every order received', 'navy', ''],
      [
        'Valid order value',
        money(summary.order_value),
        'Excludes cancelled and rejected',
        'green',
        '',
      ],
      ['Open orders', whole(summary.live_orders), 'Still active or awaiting action', 'amber', ''],
      [
        'Cancelled / rejected',
        whole(number(summary.cancelled_orders) + number(summary.rejected_orders)),
        `${whole(summary.cancelled_orders)} cancelled · ${whole(summary.rejected_orders)} rejected`,
        'red',
        '',
      ],
      ['Tips recorded', money(summary.tips), 'UPI overpayment saved as tips', 'amber', ''],
    ];
    elements.kpis.innerHTML = cards
      .map(
        ([label, value, help, tone, comparisonHtml]) =>
          `<article class="analytics-kpi ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(help)}</small>${comparisonHtml}</article>`
      )
      .join('');
  }

  function renderTrend(data) {
    const rows = Array.isArray(data.trend) ? data.trend : [];
    const max = Math.max(0, ...rows.map((row) => number(row.sales)));
    const monthly = number(data.range?.days) > 62;
    elements.trendTotal.textContent = money(data.summary?.net_sales);
    elements.trend.innerHTML = rows.length
      ? rows
          .map((row) => {
            const height = max ? Math.max(3, Math.round((number(row.sales) / max) * 155)) : 3;
            const label = monthly
              ? new Date(`${String(row.day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', {
                  month: 'short',
                  timeZone: 'UTC',
                })
              : dayLabel(row.day);
            return `<div class="analytics-bar-column" title="${escapeHtml(`${dayLabel(row.day, true)} · ${money(row.sales)} · ${whole(row.bills)} bills`)}"><b>${escapeHtml(money(row.sales))}</b><i style="height:${height}px"></i><span>${escapeHtml(label)}</span></div>`;
          })
          .join('')
      : '<div class="analytics-trend-empty">No completed sales in this period.</div>';
    elements.trend.style.width = rows.length > 20 ? `${rows.length * 38}px` : '100%';
  }

  function renderBreakdowns(data) {
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const max = Math.max(0, ...channels.map((row) => number(row.sales)));
    const channelNames = {
      dine_in: 'Dine-in tables',
      takeaway: 'Takeaway / counter',
      delivery: 'Delivery',
      business_qr: 'Business Card QR',
    };
    elements.channels.innerHTML = channels.length
      ? channels
          .map(
            (row) =>
              `<div class="analytics-breakdown-row"><span>${escapeHtml(channelNames[row.channel] || title(row.channel))} · ${whole(row.bills)} bills</span><b>${escapeHtml(money(row.sales))}</b><div class="analytics-progress"><i style="width:${max ? Math.max(3, (number(row.sales) / max) * 100) : 0}%"></i></div></div>`
          )
          .join('')
      : '<div class="analytics-empty">No completed channel sales.</div>';

    const payments = Array.isArray(data.payments) ? data.payments : [];
    const paymentNames = {
      cash: 'Cash',
      upi: 'UPI / GPay',
      card: 'Card',
      due: 'Due',
      part: 'Part payment',
      other: 'Other',
      not_recorded: 'Not recorded',
    };
    elements.payments.innerHTML = payments.length
      ? payments
          .map(
            (row) =>
              `<div class="analytics-payment-row"><span>${escapeHtml(paymentNames[row.payment_type] || title(row.payment_type))} · ${whole(row.bills)}</span><b>${escapeHtml(money(row.amount))}</b></div>`
          )
          .join('')
      : '<div class="analytics-empty">No payments recorded.</div>';
  }

  function renderOperationalStats(data) {
    const kots = data.kots?.summary || {};
    const bills = data.bills?.summary || {};
    elements.kotStats.innerHTML = [
      ['Total KOTs', kots.total_kots, ''],
      ['Cancelled', kots.cancelled_kots, 'alert'],
      ['Modified', kots.modified_kots, 'warning'],
      ['Shifted', kots.shifted_kots, ''],
    ]
      .map(
        ([label, value, tone]) =>
          `<div class="analytics-mini-stat ${tone}"><strong>${whole(value)}</strong><span>${escapeHtml(label)}</span></div>`
      )
      .join('');
    elements.billStats.innerHTML = [
      ['Bills issued', bills.issued_bills, ''],
      ['Completed', bills.completed_bills, ''],
      ['Cancelled', bills.cancelled_bills, 'alert'],
      ['Modified after print', bills.modified_bills, 'warning'],
    ]
      .map(
        ([label, value, tone]) =>
          `<div class="analytics-mini-stat ${tone}"><strong>${whole(value)}</strong><span>${escapeHtml(label)}</span></div>`
      )
      .join('');
  }

  function tableLocation(row) {
    return row.table_number
      ? `${row.table_area || 'Table'} ${String(row.table_number).padStart(2, '0')}`
      : row.mode === 'table'
        ? 'Dine-in'
        : 'Parcel';
  }

  function exceptionDetail(row) {
    const details = row.details || {};
    if (row.kind === 'cancelled') return details.reason || 'Order cancelled';
    if (row.kind === 'shifted')
      return `${details.fromArea || 'Table'} ${details.fromNumber || '—'} → ${details.toArea || 'Table'} ${details.toNumber || '—'}`;
    return details.captainName
      ? `Changed by ${details.captainName}`
      : details.itemCount
        ? `${whole(details.itemCount)} items after prior document`
        : 'Items changed after prior document';
  }

  function renderExceptions(data) {
    const kots = Array.isArray(data.kots?.exceptions) ? data.kots.exceptions : [];
    const bills = Array.isArray(data.bills?.exceptions) ? data.bills.exceptions : [];
    const kotSummary = data.kots?.summary || {};
    const billSummary = data.bills?.summary || {};
    elements.kotExceptionCount.textContent = whole(
      number(kotSummary.cancelled_kots) +
        number(kotSummary.modified_kots) +
        number(kotSummary.shifted_kots)
    );
    elements.billExceptionCount.textContent = whole(
      number(billSummary.cancelled_bills) + number(billSummary.modified_bills)
    );
    elements.kotExceptions.innerHTML = kots.length
      ? kots
          .map(
            (row) =>
              `<tr><td><span class="analytics-event ${escapeHtml(row.kind)}">${escapeHtml(row.kind)}</span><small>${escapeHtml(exceptionDetail(row))}</small></td><td><strong>KOT #${escapeHtml(row.kot_number || '—')}</strong><small>Order #${escapeHtml(String(row.daily_order_number || '—').padStart(2, '0'))}${number(row.affected_kots) > 1 ? ` · ${whole(row.affected_kots)} rounds` : ''}</small></td><td>${escapeHtml(tableLocation(row))}</td><td>${escapeHtml(dateTime(row.event_at))}</td></tr>`
          )
          .join('')
      : emptyRow(4, 'No cancelled, modified or shifted KOT activity in this period.');
    elements.billExceptions.innerHTML = bills.length
      ? bills
          .map(
            (row) =>
              `<tr><td><span class="analytics-event ${escapeHtml(row.kind)}">${escapeHtml(row.kind)}</span><small>${escapeHtml(exceptionDetail(row))}</small></td><td><strong>Bill #${escapeHtml(row.bill_number || '—')}</strong><small>Order #${escapeHtml(String(row.daily_order_number || '—').padStart(2, '0'))} · ${escapeHtml(tableLocation(row))}</small></td><td>${escapeHtml(money(row.total))}</td><td>${escapeHtml(dateTime(row.event_at))}</td></tr>`
          )
          .join('')
      : emptyRow(4, 'No cancelled or post-print modified bills in this period.');
  }

  function renderBottom(data) {
    const items = Array.isArray(data.topItems) ? data.topItems : [];
    elements.topItems.innerHTML = items.length
      ? items
          .map(
            (item, index) =>
              `<div class="analytics-top-item"><span><i class="analytics-rank">${index + 1}</i>${escapeHtml(item.name)} <em>· ${escapeHtml(item.portion)}</em></span><b>${whole(item.quantity)} sold · ${escapeHtml(money(item.sales))}</b></div>`
          )
          .join('')
      : '<div class="analytics-empty">No completed dish sales in this period.</div>';

    const orders = Array.isArray(data.recentOrders) ? data.recentOrders : [];
    elements.orders.innerHTML = orders.length
      ? orders
          .map(
            (order) =>
              `<tr><td><strong>#${escapeHtml(String(order.daily_order_number || '—').padStart(2, '0'))}</strong><small>Bill #${escapeHtml(order.bill_number || '—')}</small></td><td>${escapeHtml(tableLocation(order))}</td><td><span class="analytics-event ${['cancelled', 'rejected'].includes(order.status) ? 'cancelled' : ''}">${escapeHtml(title(order.status))}</span></td><td><strong>${escapeHtml(money(order.total))}</strong></td><td>${escapeHtml(dateTime(order.created_at))}</td></tr>`
          )
          .join('')
      : emptyRow(5, 'No orders were placed in this period.');
  }

  function renderDefinitions(definitions = {}) {
    const names = {
      sales: 'Sales',
      cancelledKot: 'Cancelled KOT',
      modifiedKot: 'Modified KOT',
      shiftedKot: 'Shifted KOT',
      cancelledBill: 'Cancelled bill',
      modifiedBill: 'Modified bill',
    };
    elements.definitions.innerHTML = Object.entries(definitions)
      .map(
        ([key, value]) =>
          `<div class="analytics-definition"><b>${escapeHtml(names[key] || title(key))}</b><span>${escapeHtml(value)}</span></div>`
      )
      .join('');
  }

  async function load() {
    if (loading) return;
    loading = true;
    elements.error.textContent = '';
    elements.refresh.disabled = true;
    elements.refresh.textContent = 'Refreshing…';
    root.setAttribute('aria-busy', 'true');
    try {
      const params = new URLSearchParams({ preset });
      if (preset === 'custom') {
        params.set('from', elements.from.value);
        params.set('to', elements.to.value);
      }
      const response = await fetch(`/api/admin/analytics?${params}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data.loginUrl) {
        window.location.replace(data.loginUrl);
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Unable to load the sales dashboard.');
      renderKpis(data);
      renderTrend(data);
      renderBreakdowns(data);
      renderOperationalStats(data);
      renderExceptions(data);
      renderBottom(data);
      renderDefinitions(data.definitions);
      elements.range.textContent = data.range?.label || 'Selected period';
      elements.generated.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} · compared with the previous ${data.range?.days || 1} day${data.range?.days === 1 ? '' : 's'}`;
      loadedAt = Date.now();
    } catch (error) {
      elements.error.textContent = error.message || 'Unable to load the sales dashboard.';
    } finally {
      loading = false;
      elements.refresh.disabled = false;
      elements.refresh.textContent = 'Refresh data';
      root.removeAttribute('aria-busy');
    }
  }

  $$('.analytics-periods button').forEach((button) => {
    button.addEventListener('click', () => {
      preset = button.dataset.analyticsPreset;
      $$('.analytics-periods button').forEach((candidate) =>
        candidate.classList.toggle('is-active', candidate === button)
      );
      elements.custom.hidden = preset !== 'custom';
      if (preset !== 'custom') load();
    });
  });
  elements.apply.addEventListener('click', load);
  elements.refresh.addEventListener('click', load);
  elements.print.addEventListener('click', () => {
    document.body.classList.add('analytics-print-mode');
    const clean = () => document.body.classList.remove('analytics-print-mode');
    window.addEventListener('afterprint', clean, { once: true });
    window.print();
    setTimeout(clean, 1500);
  });
  document.getElementById('dashboard-logout')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Signing out…';
    try {
      await fetch('/api/admin/session', { method: 'DELETE' });
    } finally {
      window.location.replace('/staff-login?scope=admin&next=%2Fdashboard');
    }
  });
  document.addEventListener('admin-tab-change', (event) => {
    if (event.detail?.targetId === 'tab-sales-dashboard' && Date.now() - loadedAt > 60000) load();
  });
  if (root.classList.contains('active')) load();
})();

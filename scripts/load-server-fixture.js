// Deliberately incomplete SQL model for the LOCAL Express load harness.
// This never contacts PostgreSQL. Unrecognized queries fail rather than silently
// producing a successful request from an empty response.
const { defaultSmartKdsConfig } = require('../smart-kds-domain');

const clone = (value) => JSON.parse(JSON.stringify(value));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function splitExpressions(value) {
  const parts = [];
  let start = 0,
    depth = 0,
    quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && value[index + 1] === "'" && quoted) {
      index += 1;
      continue;
    }
    if (character === "'") quoted = !quoted;
    if (!quoted && character === '(') depth += 1;
    if (!quoted && character === ')') depth -= 1;
    if (!quoted && character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function statement(first, ...rest) {
  if (Array.isArray(first) && first.raw)
    return {
      text: first.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, ''),
      values: rest,
    };
  return { text: String(first), values: Array.isArray(rest[0]) ? rest[0] : rest };
}

function createLoadFixture({ minimumDelayMs = 20, maximumDelayMs = 40, concurrency = 24 } = {}) {
  const orders = new Map(),
    requests = new Map(),
    counters = new Map(),
    profiles = new Map(),
    tasks = new Map();
  const events = [],
    unknownQueries = new Set(),
    queryCounts = new Map(),
    queue = [];
  let active = 0,
    queries = 0,
    peakActive = 0,
    peakWaiting = 0,
    realtimeId = 0;
  const menu = {
    items: Array.from({ length: 200 }, (_, index) => ({
      name: `Load fixture dish ${index + 1} sample`,
      category: index % 2 ? 'SOUP' : 'QUICK BITES',
      price: `₹${100 + index}`,
      veg: true,
    })),
    barItems: [],
    loyalty: { enabled: false },
    orderingEnabled: true,
  };
  const operations = { printers: [], routes: [], tableAreas: [{ name: 'AC', from: 1, to: 200 }] };
  const kitchenConfig = defaultSmartKdsConfig();

  function parseInserted(query) {
    const match = query.text.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s+VALUES\s*\(/is);
    if (!match)
      throw new Error('Fixture cannot parse INSERT shape. Extend its explicit SQL model.');
    const names = match[1].split(',').map((name) => name.trim());
    const remainder = query.text.slice(match.index + match[0].length);
    let depth = 1,
      quoted = false,
      end = -1;
    for (let index = 0; index < remainder.length; index += 1) {
      if (remainder[index] === "'") quoted = !quoted;
      if (!quoted && remainder[index] === '(') depth += 1;
      if (!quoted && remainder[index] === ')') depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
    if (end < 0) throw new Error('Fixture INSERT values are not balanced.');
    const expressions = splitExpressions(remainder.slice(0, end));
    const row = {};
    names.forEach((name, index) => {
      const expression = expressions[index] || '';
      const parameter = expression.match(/^\$(\d+)(?:::.*)?$/);
      if (parameter) row[name] = query.values[Number(parameter[1]) - 1];
      else if (/^NOW\(\)$/i.test(expression)) row[name] = new Date().toISOString();
      else if (/^NULL$/i.test(expression)) row[name] = null;
      else if (/^(TRUE|FALSE)$/i.test(expression)) row[name] = expression.toLowerCase() === 'true';
      else if (/^'.*'$/.test(expression)) row[name] = expression.slice(1, -1).replace(/''/g, "'");
      else if (/^-?\d+(\.\d+)?$/.test(expression)) row[name] = Number(expression);
      else throw new Error(`Fixture cannot parse INSERT expression for ${name}.`);
    });
    ['items', 'profile_snapshot', 'details'].forEach((name) => {
      if (typeof row[name] === 'string') row[name] = JSON.parse(row[name]);
    });
    return row;
  }

  function execute(query) {
    const text = query.text.replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const values = query.values;
    const label = lower.match(/(?:from|into|update)\s+([a-z_]+)/)?.[1] || lower.split(' ')[0];
    queryCounts.set(label, (queryCounts.get(label) || 0) + 1);
    if (/\blimit 0\b/i.test(text)) return [];
    if (/^(create|alter)\s/i.test(text)) return [];
    if (/^select\s+1(?:\s|;|$)/i.test(text)) return [{ ready: 1 }];
    if (lower.includes('from website_content')) {
      const id = values[0];
      if (id === 'air_menu_content') return [{ data: clone(menu) }];
      if (id === 'captain_content') return [{ data: { captains: [] } }];
      return [{ data: {} }];
    }
    if (
      lower.startsWith('insert into direct_order_counters') ||
      lower.startsWith('insert into direct_order_bill_counters')
    ) {
      const key = `${label}:${values[0]}`;
      const number = (counters.get(key) || 0) + 1;
      counters.set(key, number);
      return [{ next_number: number }];
    }
    if (lower.startsWith('insert into direct_orders')) {
      const row = parseInserted(query);
      if (orders.has(row.id) || (row.client_request_id && requests.has(row.client_request_id)))
        throw Object.assign(new Error('Fixture unique order request constraint'), {
          code: '23505',
        });
      if (
        row.mode === 'table' &&
        [...orders.values()].some(
          (order) =>
            order.order_day === row.order_day &&
            order.table_area === row.table_area &&
            order.table_number === row.table_number &&
            ['saved', 'held', 'accepted', 'preparing', 'ready'].includes(order.status)
        )
      )
        throw Object.assign(new Error('Fixture unique active table constraint'), { code: '23505' });
      row.created_at = row.updated_at = new Date().toISOString();
      row.service_priority = 'normal';
      orders.set(row.id, row);
      if (row.client_request_id) requests.set(row.client_request_id, row.id);
      return [{ id: row.id }];
    }
    if (lower.startsWith('update direct_orders set status=')) {
      const idParameter = text.match(/WHERE id=\$(\d+)/i);
      const previousParameter = text.match(/AND status=\$(\d+)/i);
      const row = orders.get(values[Number(idParameter?.[1]) - 1]);
      if (!row || row.status !== values[Number(previousParameter?.[1]) - 1]) return [];
      row.status = values[0];
      row.updated_at = new Date().toISOString();
      return [{ id: row.id }];
    }
    if (
      lower.includes('from direct_orders') &&
      (lower.startsWith('select') || lower.startsWith('with visible_order_ids'))
    ) {
      let selected = [...orders.values()];
      if (lower.includes('client_request_id='))
        selected = selected.filter((row) => row.client_request_id === values[0]);
      const id = text.match(/\b(?:o\.)?id\s*=\s*\$(\d+)/i);
      if (id) selected = selected.filter((row) => row.id === values[Number(id[1]) - 1]);
      const idSet = text.match(/\b(?:o\.)?id\s*=\s*ANY\(\$(\d+)\)/i);
      if (idSet) selected = selected.filter((row) => values[Number(idSet[1]) - 1].includes(row.id));
      const area = text.match(/table_area=\$(\d+)/i),
        table = text.match(/table_number=\$(\d+)/i);
      if (area) selected = selected.filter((row) => row.table_area === values[Number(area[1]) - 1]);
      if (table)
        selected = selected.filter((row) => row.table_number === values[Number(table[1]) - 1]);
      if (/WHERE status IN|AND status IN/i.test(text))
        selected = selected.filter((row) =>
          ['saved', 'held', 'accepted', 'preparing', 'ready'].includes(row.status)
        );
      if (lower.includes('as active_order_count')) {
        const activeOrders = selected.filter((row) =>
          ['new', 'accepted', 'preparing', 'ready'].includes(row.status)
        );
        return [
          {
            active_order_count: activeOrders.length,
            latest_active_order_number: Math.max(
              0,
              ...activeOrders.map((row) => row.daily_order_number)
            ),
            latest_order_number: Math.max(0, ...selected.map((row) => row.daily_order_number)),
          },
        ];
      }
      if (/status IN \('accepted','preparing','ready'\)/i.test(text))
        selected = selected.filter((row) =>
          ['accepted', 'preparing', 'ready'].includes(row.status)
        );
      const limit = text.match(/LIMIT\s+(\d+)/i);
      return clone(limit ? selected.slice(-Number(limit[1])).reverse() : selected);
    }
    if (lower.includes('from order_operations_config')) return [{ config: clone(operations) }];
    if (lower.includes('from kitchen_scheduling_config')) return [{ config: clone(kitchenConfig) }];
    if (lower.includes('from kitchen_stations')) return [];
    if (lower.includes('from menu_availability')) return [];
    if (lower.startsWith('insert into menu_production_profiles')) {
      const row = parseInserted(query);
      profiles.set(row.item_key, row);
      return [];
    }
    if (lower.includes('from menu_production_profiles')) return clone([...profiles.values()]);
    if (lower.startsWith('insert into kitchen_production_tasks')) {
      const row = parseInserted(query);
      const previous = tasks.get(row.task_id);
      tasks.set(row.task_id, {
        ...previous,
        ...row,
        task_state: previous?.task_state || row.task_state,
      });
      return [];
    }
    if (lower.includes('from kitchen_production_tasks')) {
      let selected = [...tasks.values()];
      const orderId = text.match(/order_id\s*=\s*\$(\d+)/i);
      const orderIds = text.match(/order_id\s*=\s*ANY\(\$(\d+)\)/i);
      if (orderId)
        selected = selected.filter((row) => row.order_id === values[Number(orderId[1]) - 1]);
      if (orderIds)
        selected = selected.filter((row) => values[Number(orderIds[1]) - 1].includes(row.order_id));
      return clone(selected);
    }
    if (lower.startsWith('insert into order_events')) {
      events.push(parseInserted(query));
      return [];
    }
    if (lower.startsWith('insert into kitchen_realtime_events'))
      return [{ event_id: ++realtimeId, created_at: new Date().toISOString() }];
    if (lower.startsWith('insert into website_diagnostics')) return [];
    if (
      lower.includes('from kitchen_manual_overrides') ||
      lower.includes('from order_push_subscriptions')
    )
      return [];
    if (
      /^(insert into|update) (kitchen_task_events|kitchen_order_courses|kitchen_scheduling_config|kitchen_station_state|kitchen_stations)\b/i.test(
        text
      )
    )
      return [];
    unknownQueries.add(text.slice(0, 180));
    throw new Error(`Unmodeled LOCAL load fixture query: ${text.slice(0, 100)}`);
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const { operation, resolve, reject } = queue.shift();
      active += 1;
      peakActive = Math.max(peakActive, active);
      const delay = minimumDelayMs + (queries++ % Math.max(1, maximumDelayMs - minimumDelayMs + 1));
      wait(delay)
        .then(operation)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
  function schedule(operation) {
    return new Promise((resolve, reject) => {
      queue.push({ operation, resolve, reject });
      peakWaiting = Math.max(peakWaiting, queue.length);
      drain();
    });
  }
  const sql = (...arguments_) => {
    const query = statement(...arguments_);
    return schedule(() => execute(query));
  };
  sql.transaction = (operation) => {
    const tx = (...arguments_) => statement(...arguments_);
    const statements = typeof operation === 'function' ? operation(tx) : operation;
    return schedule(() => statements.map(execute));
  };

  return {
    sql,
    orders,
    requests,
    tasks,
    events,
    menu,
    setDelay(minimum, maximum) {
      minimumDelayMs = minimum;
      maximumDelayMs = maximum;
    },
    snapshot: () => ({
      orders: orders.size,
      requests: requests.size,
      tasks: tasks.size,
      events: events.length,
      queries,
      activeQueries: active,
      waitingQueries: queue.length,
      peakActiveQueries: peakActive,
      peakWaitingQueries: peakWaiting,
      queryCounts: Object.fromEntries(queryCounts),
      unknownQueries: [...unknownQueries],
    }),
    async settle(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      let quiet = 0;
      while (Date.now() < deadline) {
        if (!active && !queue.length) quiet += 1;
        else quiet = 0;
        if (quiet >= 4) return true;
        await wait(25);
      }
      return false;
    },
  };
}

module.exports = { createLoadFixture, statement };

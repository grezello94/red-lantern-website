const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 16;

function cellText(cell) {
  const text = String(cell?.text || '').trim();
  if (text) return text;

  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined && value.result !== null) return String(value.result).trim();
    if (value.text !== undefined && value.text !== null) return String(value.text).trim();
    if (Array.isArray(value.richText))
      return value.richText
        .map((part) => String(part?.text || ''))
        .join('')
        .trim();
  }
  return String(value).trim();
}

function normalizePhone(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';

  // Excel can display a number using scientific notation. Expand it only when
  // it is still a safe integer; otherwise the spreadsheet has already lost
  // digits and the row must not be imported as a different phone number.
  if (/^[+]?[\d.]+e[+-]?\d+$/i.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return '';
    raw = String(numeric);
  }

  const phone = raw.replace(/\D/g, '');
  return phone.length >= MIN_PHONE_DIGITS && phone.length <= MAX_PHONE_DIGITS ? phone : '';
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .slice(0, 80);
}

function prepareTrustedContacts(rows = []) {
  const contactsByPhone = new Map();
  const duplicatePhones = [];
  let duplicateRows = 0;
  let invalidRows = 0;
  let blankRows = 0;

  for (const row of rows) {
    const rawPhone = String(row?.phone ?? '').trim();
    if (!rawPhone) {
      blankRows += 1;
      continue;
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      invalidRows += 1;
      continue;
    }

    const name = normalizeName(row?.name);
    const existing = contactsByPhone.get(phone);
    if (existing) {
      duplicateRows += 1;
      if (!existing.name && name) existing.name = name;
      if (duplicatePhones.length < 10 && !duplicatePhones.includes(phone))
        duplicatePhones.push(phone);
      continue;
    }

    contactsByPhone.set(phone, { phone, name });
  }

  return {
    contacts: [...contactsByPhone.values()],
    duplicateRows,
    duplicatePhones,
    invalidRows,
    blankRows,
  };
}

function chunks(values = [], size = 500) {
  const safeSize = Math.max(1, Math.floor(Number(size) || 500));
  const result = [];
  for (let index = 0; index < values.length; index += safeSize)
    result.push(values.slice(index, index + safeSize));
  return result;
}

module.exports = {
  MIN_PHONE_DIGITS,
  MAX_PHONE_DIGITS,
  cellText,
  normalizePhone,
  normalizeName,
  prepareTrustedContacts,
  chunks,
};

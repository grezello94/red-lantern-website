'use strict';

const PAYMENT_TYPES = Object.freeze([
  'cash',
  'upi',
  'card',
  'zomato',
  'other',
  'due',
  'not_paid',
  'part',
]);
const COLLECTED_TYPES = new Set(['cash', 'upi', 'card', 'zomato', 'other', 'part']);

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

function normalType(value) {
  const type = String(value || '').trim().toLowerCase();
  return PAYMENT_TYPES.includes(type) ? type : '';
}

function normalizeEntry(source, index) {
  const paymentType = normalType(source?.paymentType || source?.payment_type);
  if (!paymentType) throw new Error(`Choose a valid payment method for payment ${index + 1}.`);
  const appliedAmount = money(source?.amount ?? source?.appliedAmount ?? source?.applied_amount);
  if (appliedAmount <= 0) throw new Error(`Enter an amount greater than zero for payment ${index + 1}.`);
  const unpaid = paymentType === 'due' || paymentType === 'not_paid';
  const suppliedReceived = Number(source?.paymentReceived ?? source?.receivedAmount ?? source?.received_amount);
  const receivedAmount = unpaid
    ? 0
    : money(Number.isFinite(suppliedReceived) ? suppliedReceived : appliedAmount);
  if (!unpaid && receivedAmount < appliedAmount)
    throw new Error(`Amount received cannot be less than the applied amount for payment ${index + 1}.`);
  if (!unpaid && !['cash', 'upi'].includes(paymentType) && receivedAmount > appliedAmount)
    throw new Error(`${paymentType === 'zomato' ? 'Zomato' : 'This payment'} must match its applied amount.`);
  const changeAmount = paymentType === 'cash' ? money(receivedAmount - appliedAmount) : 0;
  const tipAmount = paymentType === 'upi' ? money(receivedAmount - appliedAmount) : 0;
  return {
    paymentType,
    appliedAmount,
    receivedAmount,
    collectedAmount: unpaid ? 0 : appliedAmount,
    changeAmount,
    tipAmount,
  };
}

function legacyEntries({ total, paymentType, amount, paymentReceived }) {
  const type = normalType(paymentType);
  if (!type) throw new Error('Choose a payment type.');
  if (type === 'due' || type === 'not_paid')
    return [normalizeEntry({ paymentType: type, amount: total }, 0)];
  if (type === 'part') {
    const paid = Math.min(total, money(paymentReceived ?? amount));
    if (paid <= 0) return [normalizeEntry({ paymentType: 'due', amount: total }, 0)];
    const entries = [normalizeEntry({ paymentType: 'part', amount: paid, paymentReceived: paid }, 0)];
    if (paid < total)
      entries.push(normalizeEntry({ paymentType: 'due', amount: money(total - paid) }, 1));
    return entries;
  }
  const supplied = Number(paymentReceived);
  const fallback = money(amount) || total;
  return [
    normalizeEntry(
      {
        paymentType: type,
        amount: total,
        paymentReceived: Number.isFinite(supplied) ? supplied : fallback,
      },
      0
    ),
  ];
}

function normalizePaymentPlan(source = {}) {
  const total = money(source.total);
  if (total < 0) throw new Error('Bill total cannot be negative.');
  let entries = Array.isArray(source.payments)
    ? source.payments.slice(0, 20).map(normalizeEntry)
    : legacyEntries({
        total,
        paymentType: source.paymentType,
        amount: source.amount,
        paymentReceived: source.paymentReceived,
      });
  if (!entries.length) throw new Error('Add at least one payment method.');
  if (total === 0 && entries.some((entry) => entry.appliedAmount > 0))
    throw new Error('A zero-value bill cannot have an applied payment.');
  const appliedTotal = money(entries.reduce((sum, entry) => sum + entry.appliedAmount, 0));
  if (Math.abs(appliedTotal - total) > 0.009)
    throw new Error(
      appliedTotal < total
        ? `Allocate the remaining ₹${money(total - appliedTotal).toFixed(2)} before saving.`
        : `Payments exceed the bill by ₹${money(appliedTotal - total).toFixed(2)}.`
    );
  const collectedTotal = money(entries.reduce((sum, entry) => sum + entry.collectedAmount, 0));
  const receivedTotal = money(entries.reduce((sum, entry) => sum + entry.receivedAmount, 0));
  const changeDue = money(entries.reduce((sum, entry) => sum + entry.changeAmount, 0));
  const tipAmount = money(entries.reduce((sum, entry) => sum + entry.tipAmount, 0));
  const outstanding = money(total - collectedTotal);
  const settlementType = entries.length === 1 ? entries[0].paymentType : 'part';
  return {
    entries,
    settlementType,
    appliedTotal,
    collectedTotal,
    receivedTotal,
    changeDue,
    tipAmount,
    outstanding,
  };
}

module.exports = {
  PAYMENT_TYPES,
  COLLECTED_TYPES,
  money,
  normalType,
  normalizePaymentPlan,
};

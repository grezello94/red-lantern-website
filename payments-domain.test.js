const { normalizePaymentPlan } = require('./payments-domain');

describe('payment plans', () => {
  test('records cash received and change without inflating collections', () => {
    expect(
      normalizePaymentPlan({ total: 490, paymentType: 'cash', paymentReceived: 500 })
    ).toMatchObject({
      settlementType: 'cash',
      collectedTotal: 490,
      receivedTotal: 500,
      changeDue: 10,
      tipAmount: 0,
      outstanding: 0,
    });
  });

  test('records UPI overpayment as a tip', () => {
    expect(
      normalizePaymentPlan({ total: 490, paymentType: 'upi', paymentReceived: 500 })
    ).toMatchObject({ collectedTotal: 490, receivedTotal: 500, tipAmount: 10, outstanding: 0 });
  });

  test('supports several tenders and a due balance', () => {
    const plan = normalizePaymentPlan({
      total: 1000,
      payments: [
        { paymentType: 'cash', amount: 300, paymentReceived: 500 },
        { paymentType: 'upi', amount: 500, paymentReceived: 510 },
        { paymentType: 'due', amount: 200 },
      ],
    });
    expect(plan).toMatchObject({
      settlementType: 'part',
      appliedTotal: 1000,
      collectedTotal: 800,
      receivedTotal: 1010,
      changeDue: 200,
      tipAmount: 10,
      outstanding: 200,
    });
    expect(plan.entries).toHaveLength(3);
  });

  test('rejects under-allocation, over-allocation and short tender', () => {
    expect(() =>
      normalizePaymentPlan({ total: 100, payments: [{ paymentType: 'cash', amount: 80 }] })
    ).toThrow(/remaining/);
    expect(() =>
      normalizePaymentPlan({ total: 100, payments: [{ paymentType: 'cash', amount: 120 }] })
    ).toThrow(/exceed/);
    expect(() =>
      normalizePaymentPlan({
        total: 100,
        payments: [{ paymentType: 'cash', amount: 100, paymentReceived: 50 }],
      })
    ).toThrow(/cannot be less/);
    expect(() =>
      normalizePaymentPlan({ total: 100, paymentType: 'card', paymentReceived: 110 })
    ).toThrow(/must match/);
  });

  test('keeps the legacy part-payment payload compatible', () => {
    expect(normalizePaymentPlan({ total: 600, paymentType: 'part', amount: 250 })).toMatchObject({
      settlementType: 'part',
      collectedTotal: 250,
      outstanding: 350,
    });
  });
});

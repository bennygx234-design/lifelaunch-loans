'use strict';

const {
  calcAmortization,
  calcAmortizationSchedule,
  debtSnowball,
  debtAvalanche,
  compareStrategies,
  calcRefinancingBenefit,
  calcExtraPaymentImpact,
} = require('./calculations');

// ─── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, actual, expected) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        Expected: ${JSON.stringify(expected)}`);
    console.error(`        Received: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertClose(label, actual, expected, tolerance = 0.02) {
  const ok = Math.abs(actual - expected) <= tolerance;
  assert(label, ok, actual, expected);
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, actual, expected);
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ─── 1. calcAmortization ──────────────────────────────────────────────────────

section('1. calcAmortization');

// Standard 30-year mortgage: $200,000 @ 6% → M ≈ $1,199.10
{
  const result = calcAmortization(200000, 6, 360);
  assertClose('monthly payment ~1199.10', result.monthlyPayment, 1199.10, 1);
  assertClose('total cost ~431,676', result.totalCost, 431676, 5);
  assertClose('total interest ~231,676', result.totalInterest, 231676, 5);
  assertEq('payoff months = 360', result.payoffMonths, 360);
}

// Short-term loan: $10,000 @ 5% for 24 months → M ≈ $438.71
{
  const result = calcAmortization(10000, 5, 24);
  assertClose('monthly payment ~438.71', result.monthlyPayment, 438.71, 1);
  assertClose('total interest ~529.04', result.totalInterest, 529.04, 2);
}

// Zero interest: $6,000 @ 0% for 12 months → M = $500.00
{
  const result = calcAmortization(6000, 0, 12);
  assertEq('zero-rate monthly = 500', result.monthlyPayment, 500);
  assertEq('zero-rate totalInterest = 0', result.totalInterest, 0);
}

// Edge: zero principal
{
  const result = calcAmortization(0, 5, 60);
  assertEq('zero principal → zero payment', result.monthlyPayment, 0);
}

// Edge: zero term
{
  const result = calcAmortization(10000, 5, 0);
  assertEq('zero term → zero payment', result.monthlyPayment, 0);
}

// ─── 2. calcAmortizationSchedule ─────────────────────────────────────────────

section('2. calcAmortizationSchedule');

{
  const schedule = calcAmortizationSchedule(40000, 6, 84);

  assertEq('schedule length = 84', schedule.length, 84);

  const first = schedule[0];
  // Month 1 interest = 40000 * (6/12/100) = 200.00
  assertClose('month 1 interest = 200.00', first.interest, 200.00, 0.02);
  assertEq('month 1 month number', first.month, 1);
  assert('month 1 principal > 0', first.principal > 0, first.principal, '>0');

  const last = schedule[schedule.length - 1];
  assertEq('last month balance = 0', last.balance, 0);
  assert('last payment covers remaining', last.payment > 0, last.payment, '>0');

  // Each row: payment = principal + interest
  const valid = schedule.every(
    (r) => Math.abs(r.payment - r.principal - r.interest) < 0.02
  );
  assertEq('every row: payment = principal + interest', valid, true);

  // Balance should be non-negative throughout
  const balancesOk = schedule.every((r) => r.balance >= 0);
  assertEq('all balances >= 0', balancesOk, true);
}

// Zero principal → empty schedule
{
  const schedule = calcAmortizationSchedule(0, 5, 12);
  assertEq('zero principal → empty array', schedule.length, 0);
}

// ─── 3. debtSnowball ──────────────────────────────────────────────────────────

section('3. debtSnowball');

const sampleLoans = [
  { id: 'credit_card', balance: 3000, rate: 19.99, monthlyPayment: 90 },
  { id: 'car_loan',    balance: 8500, rate: 6.5,  monthlyPayment: 220 },
  { id: 'student',     balance: 1500, rate: 4.5,  monthlyPayment: 60 },
];

{
  const result = debtSnowball(sampleLoans);
  assertEq('snowball: returns order array', Array.isArray(result.order), true);
  // Snowball sorts by balance → student (1500), credit_card (3000), car_loan (8500)
  assertEq('snowball: first payoff = student', result.order[0], 'student');
  assertEq('snowball: second payoff = credit_card', result.order[1], 'credit_card');
  assertEq('snowball: last payoff = car_loan', result.order[2], 'car_loan');
  assert('snowball: totalInterest > 0', result.totalInterest > 0, result.totalInterest, '>0');
  assert('snowball: payoffMonths > 0', result.payoffMonths > 0, result.payoffMonths, '>0');
}

// Edge: empty loans
{
  const result = debtSnowball([]);
  assertEq('snowball empty loans → payoffMonths 0', result.payoffMonths, 0);
}

// ─── 4. debtAvalanche ─────────────────────────────────────────────────────────

section('4. debtAvalanche');

{
  const result = debtAvalanche(sampleLoans);
  assertEq('avalanche: returns order array', Array.isArray(result.order), true);
  // Avalanche sorts by rate desc → credit_card (19.99%), car_loan (6.5%), student (4.5%)
  assertEq('avalanche: first payoff = credit_card', result.order[0], 'credit_card');
  assertEq('avalanche: second payoff = car_loan', result.order[1], 'car_loan');
  assertEq('avalanche: last payoff = student', result.order[2], 'student');
  assert('avalanche: totalInterest > 0', result.totalInterest > 0, result.totalInterest, '>0');
  assert('avalanche: payoffMonths > 0', result.payoffMonths > 0, result.payoffMonths, '>0');
}

// Avalanche must pay less interest than snowball on these loans
// (credit card has highest rate AND is not the smallest balance)
{
  const snowball  = debtSnowball(sampleLoans);
  const avalanche = debtAvalanche(sampleLoans);
  assert(
    'avalanche totalInterest <= snowball totalInterest',
    avalanche.totalInterest <= snowball.totalInterest,
    { avalanche: avalanche.totalInterest, snowball: snowball.totalInterest },
    'avalanche <= snowball'
  );
}

// Edge: empty loans
{
  const result = debtAvalanche([]);
  assertEq('avalanche empty loans → payoffMonths 0', result.payoffMonths, 0);
}

// ─── 5. compareStrategies ─────────────────────────────────────────────────────

section('5. compareStrategies');

{
  const result = compareStrategies(sampleLoans);

  assert('has snowball key', 'snowball' in result, result, 'snowball key');
  assert('has avalanche key', 'avalanche' in result, result, 'avalanche key');
  assert('has betterStrategy key', 'betterStrategy' in result, result, 'betterStrategy key');
  assert('has interestSaved key', 'interestSaved' in result, result, 'interestSaved key');

  assert(
    'betterStrategy is valid value',
    ['snowball', 'avalanche', 'tie'].includes(result.betterStrategy),
    result.betterStrategy,
    'snowball|avalanche|tie'
  );
  assert('interestSaved >= 0', result.interestSaved >= 0, result.interestSaved, '>=0');

  // With sampleLoans, minimums are large enough that both strategies converge to a
  // tie — the simulation is correct. Verify that the result is internally consistent.
  assert(
    'betterStrategy is tie or avalanche (depending on minimum sizes)',
    ['tie', 'avalanche'].includes(result.betterStrategy),
    result.betterStrategy,
    'tie or avalanche'
  );
  assert('interestSaved >= 0 (same interest when strategies tie)', result.interestSaved >= 0, result.interestSaved, '>=0');
}

// Diverging scenario: 3 loans where B has the highest rate but not the smallest balance.
// Snowball order: C(500) → A(2000) → B(3000)   — pays tiny low-rate loan first
// Avalanche order: B(3000@25%) → A(2000@10%) → C(500@4%)  — attacks 25%-rate loan first
// Keeping B's balance high longer (snowball) costs significantly more in interest.
{
  const divergingLoans = [
    { id: 'A', balance: 2000, rate: 10, monthlyPayment: 50 },
    { id: 'B', balance: 3000, rate: 25, monthlyPayment: 50 },
    { id: 'C', balance: 500,  rate: 4,  monthlyPayment: 50 },
  ];
  const result = compareStrategies(divergingLoans);
  assert('diverging: betterStrategy is avalanche', result.betterStrategy === 'avalanche', result.betterStrategy, 'avalanche');
  assert('diverging: interestSaved > 0', result.interestSaved > 0, result.interestSaved, '>0');
  assert('diverging: interestSaved > 400', result.interestSaved > 400, result.interestSaved, '>400');
}

// Tie scenario: single loan — both strategies are identical
{
  const singleLoan = [{ id: 'only', balance: 5000, rate: 8, monthlyPayment: 120 }];
  const result = compareStrategies(singleLoan);
  assertEq('single loan → tie', result.betterStrategy, 'tie');
  assertEq('single loan → interestSaved = 0', result.interestSaved, 0);
}

// ─── 6. calcRefinancingBenefit ────────────────────────────────────────────────

section('6. calcRefinancingBenefit');

// Refinancing $300,000 from 7% → 5% over 30 years
{
  const result = calcRefinancingBenefit(300000, 7, 5, 360);
  assert('monthly savings > 0', result.monthlySavings > 0, result.monthlySavings, '>0');
  assert('lifetime savings > 0', result.lifetimeSavings > 0, result.lifetimeSavings, '>0');
  // 7% payment ≈ $1995.91, 5% payment ≈ $1610.46 → monthly savings ≈ $385
  assertClose('monthly savings ~385', result.monthlySavings, 385, 5);
  // Lifetime savings ≈ 385 * 360 ≈ $138,600
  assertClose('lifetime savings ~138,600', result.lifetimeSavings, 138600, 500);
}

// Refinancing to a higher rate should produce negative (or zero) savings
{
  const result = calcRefinancingBenefit(200000, 4, 7, 360);
  assert('refinancing to higher rate: monthly savings < 0', result.monthlySavings < 0, result.monthlySavings, '<0');
  assert('refinancing to higher rate: lifetime savings < 0', result.lifetimeSavings < 0, result.lifetimeSavings, '<0');
}

// Same rate → zero savings
{
  const result = calcRefinancingBenefit(150000, 5, 5, 240);
  assertEq('same rate → monthly savings = 0', result.monthlySavings, 0);
  assertEq('same rate → lifetime savings = 0', result.lifetimeSavings, 0);
}

// ─── 7. calcExtraPaymentImpact ────────────────────────────────────────────────

section('7. calcExtraPaymentImpact');

// $200,000 @ 5% / 30yr, +$200/month extra
{
  const result = calcExtraPaymentImpact(200000, 5, 360, 200);
  assert('months early > 0', result.monthsEarly > 0, result.monthsEarly, '>0');
  assert('interest saved > 0', result.interestSaved > 0, result.interestSaved, '>0');
  assert('new payoff months < 360', result.newPayoffMonths < 360, result.newPayoffMonths, '<360');
  // Extra $200/mo on a 5% 30-year loan shaves ~8–9 years (96–108 months early)
  assert('months early between 36 and 120', result.monthsEarly >= 36 && result.monthsEarly <= 120, result.monthsEarly, '36–120');
  assert('interest saved > 10000', result.interestSaved > 10000, result.interestSaved, '>10000');
}

// Zero extra → no change
{
  const result = calcExtraPaymentImpact(100000, 6, 120, 0);
  assertEq('no extra payment → months early = 0', result.monthsEarly, 0);
  assertEq('no extra payment → interest saved = 0', result.interestSaved, 0);
  assertEq('no extra payment → newPayoffMonths = 120', result.newPayoffMonths, 120);
}

// Edge: zero principal
{
  const result = calcExtraPaymentImpact(0, 6, 60, 100);
  assertEq('zero principal → monthsEarly = 0', result.monthsEarly, 0);
}

// Large extra payment — can pay off well early
{
  const result = calcExtraPaymentImpact(50000, 8, 180, 2000);
  assert('large extra: new payoff << 180 months', result.newPayoffMonths < 100, result.newPayoffMonths, '<100');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Test Summary`);
console.log('═'.repeat(60));
console.log(`  Total  : ${passed + failed}`);
console.log(`  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);
console.log('═'.repeat(60));

if (failed > 0) {
  process.exitCode = 1;
}

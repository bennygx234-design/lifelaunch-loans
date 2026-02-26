'use strict';

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Round a number to 2 decimal places.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  if (!isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ─── 1. calcAmortization ──────────────────────────────────────────────────────

/**
 * Calculate core amortization metrics.
 *
 * Formula: M = P[r(1+r)^n] / [(1+r)^n - 1]
 * where r = annualRate / 12 / 100
 *
 * @param {number} principal     - Loan principal (dollars)
 * @param {number} annualRate    - Annual interest rate (percent, e.g. 6.5 for 6.5%)
 * @param {number} termMonths    - Loan term in months
 * @returns {{ monthlyPayment: number, totalInterest: number, totalCost: number, payoffMonths: number }}
 */
function calcAmortization(principal, annualRate, termMonths) {
  // Sanitize inputs — coerce to numbers, reject negatives/NaN
  principal  = Math.abs(parseFloat(principal)  || 0);
  annualRate = Math.abs(parseFloat(annualRate) || 0);
  termMonths = Math.abs(parseInt(termMonths)   || 0);

  // Cap extreme values to defensible limits
  if (annualRate > 999) annualRate = 999;
  if (termMonths > 1200) termMonths = 1200;

  if (!principal || !termMonths) {
    return {
      monthlyPayment: 0,
      totalInterest:  0,
      totalCost:      0,
      payoffMonths:   0,
    };
  }

  const r = annualRate / 12 / 100;

  let monthlyPayment;
  if (r === 0) {
    // Zero-interest loan: divide principal evenly
    monthlyPayment = round2(principal / termMonths);
  } else {
    const factor = Math.pow(1 + r, termMonths);
    if (!isFinite(factor) || factor === 1) {
      // Overflow guard: treat as zero-rate
      monthlyPayment = round2(principal / termMonths);
    } else {
      monthlyPayment = round2((principal * r * factor) / (factor - 1));
    }
  }

  // Monthly payment must never be below monthly interest (negative amortization guard)
  const monthlyInterestOnly = round2(principal * r);
  const neverPaysOff = monthlyPayment <= monthlyInterestOnly && r > 0;

  if (neverPaysOff) {
    // Return a result flagged so callers can warn; set payment = interest + $1 minimum
    monthlyPayment = round2(monthlyInterestOnly + 1);
  }

  const totalCost     = round2(monthlyPayment * termMonths);
  const totalInterest = round2(totalCost - principal);

  return {
    monthlyPayment,
    totalInterest: Math.max(0, totalInterest),
    totalCost,
    payoffMonths: termMonths,
    neverPaysOff: neverPaysOff || undefined,
  };
}

// ─── 2. calcAmortizationSchedule ──────────────────────────────────────────────

/**
 * Build a full month-by-month amortization schedule.
 *
 * @param {number} principal
 * @param {number} annualRate
 * @param {number} termMonths
 * @returns {Array<{ month: number, payment: number, principal: number, interest: number, balance: number }>}
 */
function calcAmortizationSchedule(principal, annualRate, termMonths) {
  // Sanitize inputs
  principal  = Math.abs(parseFloat(principal)  || 0);
  annualRate = Math.abs(parseFloat(annualRate) || 0);
  termMonths = Math.abs(parseInt(termMonths)   || 0);

  if (annualRate > 999) annualRate = 999;
  if (termMonths > 1200) termMonths = 1200;

  if (!principal || !termMonths) return [];

  const { monthlyPayment } = calcAmortization(principal, annualRate, termMonths);

  // Guard: if monthlyPayment is 0 or nonsensical, bail
  if (!monthlyPayment || !isFinite(monthlyPayment)) return [];

  const r = annualRate / 12 / 100;
  const monthlyInterestOnly = round2(principal * r);

  // Detect negative amortization: payment doesn't cover interest
  if (r > 0 && monthlyPayment <= monthlyInterestOnly) {
    // Schedule will never converge — cap at termMonths with a warning flag
    const schedule = [];
    let balance = principal;
    for (let month = 1; month <= termMonths; month++) {
      const interestCharge = round2(balance * r);
      const principalCharge = round2(monthlyPayment - interestCharge);
      balance = round2(balance - principalCharge);
      if (!isFinite(balance) || balance < 0) balance = 0;
      schedule.push({
        month,
        payment: monthlyPayment,
        principal: principalCharge,
        interest: interestCharge,
        balance,
        warning: 'payment_below_interest',
      });
    }
    return schedule;
  }

  const schedule = [];
  let balance = principal;

  for (let month = 1; month <= termMonths; month++) {
    const interestCharge  = round2(balance * r);
    const isLastMonth     = month === termMonths;

    // On the last month pay whatever remains to avoid floating-point drift
    const payment         = isLastMonth ? round2(balance + interestCharge) : monthlyPayment;
    const principalCharge = round2(payment - interestCharge);
    balance               = isLastMonth ? 0 : round2(balance - principalCharge);

    if (!isFinite(balance) || balance < 0) balance = 0;

    schedule.push({
      month,
      payment,
      principal: principalCharge,
      interest:  interestCharge,
      balance,
    });

    if (balance <= 0) break;
  }

  return schedule;
}

// ─── Internal: simulate payoff for a loan list ────────────────────────────────

/**
 * Simulate debt payoff given a priority order (IDs), collecting freed minimums
 * as extra payments ("snowball/avalanche engine").
 *
 * Each loan: { id, balance, rate, monthlyPayment }
 *
 * @param {Array<{id: string|number, balance: number, rate: number, monthlyPayment: number}>} loans
 * @param {Array<string|number>} order  - loan IDs in payoff priority order
 * @returns {{ order: Array, totalInterest: number, payoffMonths: number }}
 */
function _simulatePayoff(loans, order) {
  // Deep-clone balances so the simulation is non-destructive
  const state = loans.map((l) => ({
    id:         l.id,
    balance:    Math.max(0, parseFloat(l.balance)       || 0),
    rate:       Math.max(0, parseFloat(l.rate)          || 0),
    minPayment: Math.max(0, parseFloat(l.monthlyPayment)|| 0),
  }));

  // Index for fast lookup
  const byId = {};
  state.forEach((l) => (byId[l.id] = l));

  // Track the ordered list of IDs still active
  const remaining = order.map((id) => byId[id]).filter(Boolean);

  // Remove already-paid-off loans immediately
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (remaining[i].balance <= 0.005) remaining.splice(i, 1);
  }

  if (remaining.length === 0) {
    return { order, totalInterest: 0, payoffMonths: 0 };
  }

  let totalInterest = 0;
  let month         = 0;
  let extraPool     = 0; // freed minimum payments accumulate here
  const MAX_MONTHS  = 1200;

  // Detect if any loan has payment <= monthly interest (will never pay off)
  let hasProblematicLoan = false;
  remaining.forEach((loan) => {
    const monthlyRate     = loan.rate / 12 / 100;
    const monthlyInterest = loan.balance * monthlyRate;
    if (loan.rate > 0 && loan.minPayment <= monthlyInterest) {
      hasProblematicLoan = true;
    }
  });

  while (remaining.length > 0 && month < MAX_MONTHS) {
    month++;

    // Step 1: accrue interest on every active loan
    remaining.forEach((loan) => {
      const monthlyRate = loan.rate / 12 / 100;
      const interest    = round2(loan.balance * monthlyRate);
      if (isFinite(interest) && interest >= 0) {
        totalInterest  = round2(totalInterest + interest);
        loan.balance   = round2(loan.balance + interest);
      }
    });

    // Step 2: apply minimum payments to all loans
    remaining.forEach((loan) => {
      const payment    = Math.min(loan.minPayment, loan.balance);
      loan.balance     = round2(loan.balance - payment);
      if (loan.balance < 0) loan.balance = 0;
    });

    // Step 3: apply extra pool to the top-priority loan still active
    if (extraPool > 0 && remaining.length > 0) {
      const target = remaining[0];
      const extra  = Math.min(extraPool, target.balance);
      target.balance = round2(target.balance - extra);
      if (target.balance < 0) target.balance = 0;
    }

    // Step 4: check for payoffs — remove fully paid loans, free their minimums
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].balance <= 0.005) {
        extraPool = round2(extraPool + remaining[i].minPayment);
        remaining.splice(i, 1);
      }
    }
  }

  return {
    order,
    totalInterest:  round2(totalInterest),
    payoffMonths:   month,
    cappedAtLimit:  month >= MAX_MONTHS || undefined,
    hasProblematicLoan: hasProblematicLoan || undefined,
  };
}

// ─── 3. debtSnowball ──────────────────────────────────────────────────────────

/**
 * Debt Snowball: pay off lowest-balance loans first; motivational momentum.
 *
 * @param {Array<{id: string|number, balance: number, rate: number, monthlyPayment: number}>} loans
 * @returns {{ order: Array, totalInterest: number, payoffMonths: number }}
 */
function debtSnowball(loans) {
  if (!loans || !Array.isArray(loans) || loans.length === 0) {
    return { order: [], totalInterest: 0, payoffMonths: 0 };
  }
  // Filter out loans with nonsensical data
  const valid = loans.filter(l => l && parseFloat(l.balance) > 0);
  if (valid.length === 0) {
    return { order: [], totalInterest: 0, payoffMonths: 0 };
  }
  const order = [...valid]
    .sort((a, b) => (parseFloat(a.balance) || 0) - (parseFloat(b.balance) || 0))
    .map((l) => l.id);
  return _simulatePayoff(valid, order);
}

// ─── 4. debtAvalanche ─────────────────────────────────────────────────────────

/**
 * Debt Avalanche: pay off highest-interest-rate loans first; mathematically optimal.
 *
 * @param {Array<{id: string|number, balance: number, rate: number, monthlyPayment: number}>} loans
 * @returns {{ order: Array, totalInterest: number, payoffMonths: number }}
 */
function debtAvalanche(loans) {
  if (!loans || !Array.isArray(loans) || loans.length === 0) {
    return { order: [], totalInterest: 0, payoffMonths: 0 };
  }
  const valid = loans.filter(l => l && parseFloat(l.balance) > 0);
  if (valid.length === 0) {
    return { order: [], totalInterest: 0, payoffMonths: 0 };
  }
  const order = [...valid]
    .sort((a, b) => (parseFloat(b.rate) || 0) - (parseFloat(a.rate) || 0))
    .map((l) => l.id);
  return _simulatePayoff(valid, order);
}

// ─── 5. compareStrategies ─────────────────────────────────────────────────────

/**
 * Run both snowball and avalanche strategies and compare them.
 *
 * @param {Array<{id: string|number, balance: number, rate: number, monthlyPayment: number}>} loans
 * @returns {{
 *   snowball: { order: Array, totalInterest: number, payoffMonths: number },
 *   avalanche: { order: Array, totalInterest: number, payoffMonths: number },
 *   betterStrategy: 'snowball' | 'avalanche' | 'tie',
 *   interestSaved: number
 * }}
 */
function compareStrategies(loans) {
  if (!loans || !Array.isArray(loans) || loans.length === 0) {
    const empty = { order: [], totalInterest: 0, payoffMonths: 0 };
    return { snowball: empty, avalanche: empty, betterStrategy: 'tie', interestSaved: 0 };
  }

  const snowball  = debtSnowball(loans);
  const avalanche = debtAvalanche(loans);

  const interestSaved = round2(snowball.totalInterest - avalanche.totalInterest);

  let betterStrategy;
  if (interestSaved > 0) {
    betterStrategy = 'avalanche';
  } else if (interestSaved < 0) {
    betterStrategy = 'snowball';
  } else {
    betterStrategy = 'tie';
  }

  return {
    snowball,
    avalanche,
    betterStrategy,
    interestSaved: Math.abs(interestSaved),
  };
}

// ─── 6. calcRefinancingBenefit ────────────────────────────────────────────────

/**
 * Calculate the benefit of refinancing at a lower rate.
 *
 * @param {number} principal
 * @param {number} currentRate  - Current annual rate (percent)
 * @param {number} newRate      - New (lower) annual rate (percent)
 * @param {number} termMonths
 * @returns {{ monthlySavings: number, lifetimeSavings: number }}
 */
function calcRefinancingBenefit(principal, currentRate, newRate, termMonths) {
  // Sanitize
  principal   = Math.abs(parseFloat(principal)   || 0);
  currentRate = Math.abs(parseFloat(currentRate) || 0);
  newRate     = Math.abs(parseFloat(newRate)     || 0);
  termMonths  = Math.abs(parseInt(termMonths)    || 0);

  if (!principal || !termMonths) {
    return { monthlySavings: 0, lifetimeSavings: 0 };
  }

  const current = calcAmortization(principal, currentRate, termMonths);
  const refi    = calcAmortization(principal, newRate,     termMonths);

  const monthlySavings  = round2(current.monthlyPayment - refi.monthlyPayment);
  const lifetimeSavings = round2(current.totalCost      - refi.totalCost);

  return { monthlySavings, lifetimeSavings };
}

// ─── 7. calcExtraPaymentImpact ────────────────────────────────────────────────

/**
 * Calculate how much time and interest is saved by making extra monthly payments.
 *
 * @param {number} principal
 * @param {number} annualRate
 * @param {number} termMonths
 * @param {number} extraMonthly  - Additional amount paid each month on top of the regular payment
 * @returns {{ monthsEarly: number, interestSaved: number, newPayoffMonths: number }}
 */
function calcExtraPaymentImpact(principal, annualRate, termMonths, extraMonthly) {
  // Sanitize
  principal    = Math.abs(parseFloat(principal)    || 0);
  annualRate   = Math.abs(parseFloat(annualRate)   || 0);
  termMonths   = Math.abs(parseInt(termMonths)     || 0);
  extraMonthly = Math.max(0, parseFloat(extraMonthly) || 0);

  if (annualRate > 999) annualRate = 999;
  if (termMonths > 1200) termMonths = 1200;

  if (!principal || !termMonths) {
    return { monthsEarly: 0, interestSaved: 0, newPayoffMonths: 0 };
  }

  const { monthlyPayment } = calcAmortization(principal, annualRate, termMonths);
  if (!monthlyPayment) {
    return { monthsEarly: 0, interestSaved: 0, newPayoffMonths: 0 };
  }

  const r = annualRate / 12 / 100;

  // ── Standard payoff total interest ──
  const standardSchedule = calcAmortizationSchedule(principal, annualRate, termMonths);
  const standardInterest  = round2(
    standardSchedule.reduce((sum, row) => sum + (row.interest || 0), 0)
  );

  // ── Accelerated payoff simulation ──
  let balance             = principal;
  let month               = 0;
  let acceleratedInterest = 0;
  const totalPayment      = monthlyPayment + extraMonthly;
  const MAX_MONTHS        = Math.max(termMonths * 2, 1200);

  // Guard: if extra payment is effectively 0 or negative, fast-path
  if (extraMonthly <= 0) {
    return { monthsEarly: 0, interestSaved: 0, newPayoffMonths: termMonths };
  }

  while (balance > 0.005 && month < MAX_MONTHS) {
    month++;
    const interestCharge = round2(balance * r);

    if (!isFinite(interestCharge)) break;

    acceleratedInterest = round2(acceleratedInterest + interestCharge);

    const payment = Math.min(totalPayment, round2(balance + interestCharge));
    balance       = round2(balance + interestCharge - payment);

    if (balance < 0 || !isFinite(balance)) { balance = 0; break; }
  }

  const newPayoffMonths = month;
  const monthsEarly     = termMonths - newPayoffMonths;
  const interestSaved   = round2(standardInterest - acceleratedInterest);

  return {
    monthsEarly:    Math.max(0, monthsEarly),
    interestSaved:  Math.max(0, interestSaved),
    newPayoffMonths,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  calcAmortization,
  calcAmortizationSchedule,
  debtSnowball,
  debtAvalanche,
  compareStrategies,
  calcRefinancingBenefit,
  calcExtraPaymentImpact,
};

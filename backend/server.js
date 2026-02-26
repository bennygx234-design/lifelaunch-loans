'use strict';

// ============================================================
// LifeLaunch Loans — Express.js REST API Server
// ============================================================
// Environment variables (loaded from .env in development):
//   SUPABASE_URL       — Supabase project URL
//   SUPABASE_ANON_KEY  — Supabase anon public key
//   ANTHROPIC_API_KEY  — Anthropic API key
//   PORT               — TCP port to listen on (default 3001)
// ============================================================

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic  = require('@anthropic-ai/sdk');

// ─── Import calculation helpers ──────────────────────────────
// calculations.js lives one level above the backend directory.
// Adjust the path if the monorepo layout changes.
let calcFunctions;
try {
  calcFunctions = require('../calculations.js');
} catch (err) {
  // Graceful degradation: if the calculations module is not
  // found the server still starts, but /api/simulate will
  // return a 503 with a helpful message.
  console.warn(
    '[warn] calculations.js not found at ../calculations.js — ' +
    '/api/simulate will be unavailable until the file is present.'
  );
  calcFunctions = null;
}

// ─── Validate required environment variables ─────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(
    `[fatal] Missing required environment variables: ${missingEnv.join(', ')}\n` +
    'Copy .env.example to .env and fill in the values.'
  );
  process.exit(1);
}

const PORT           = parseInt(process.env.PORT || '3001', 10);
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_ANON  = process.env.SUPABASE_ANON_KEY;

// ─── Supabase admin client (anon key, per-request auth) ──────
// We create ONE shared client instance and attach the user's
// JWT per-request via the Authorization header forwarding
// strategy (supabase-js v2 supports per-request auth via
// createClient with a custom auth header in the fetch options,
// but the simplest approach for a REST proxy is to use the
// service-role key for server-side queries after verifying the
// token ourselves — or to trust RLS when using the anon key
// and passing the user's JWT as the Authorization header).
//
// Strategy used here: anon client for auth routes; for
// authenticated routes we verify the JWT with getUser() and
// then perform queries using a per-request client that carries
// the user's token so RLS is enforced.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false },
});

// ─── Anthropic client ────────────────────────────────────────
const anthropic = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Express app setup ───────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ─── Request logger (development) ────────────────────────────
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
});

// ============================================================
// Utilities
// ============================================================

/**
 * Build a Supabase client that carries the caller's JWT so
 * that every query is scoped by RLS to their data.
 */
function buildAuthedClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

/**
 * Standard JSON error responder.
 */
function sendError(res, status, message, details = undefined) {
  const body = { error: message };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/**
 * Standard monthly-payment amortisation formula.
 *   M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * where r is the monthly rate and n is the number of months.
 * Returns 0 for zero-rate loans.
 */
function calcMonthlyPayment(principal, annualRate, termMonths) {
  if (annualRate === 0) return principal / termMonths;
  const r = annualRate / 12;
  const n = termMonths;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

/**
 * Total interest paid over the life of a loan.
 */
function calcTotalInterest(principal, annualRate, termMonths) {
  const monthly = calcMonthlyPayment(principal, annualRate, termMonths);
  return Math.max(0, monthly * termMonths - principal);
}

/**
 * Determine whether refinancing at (currentRate - 0.02) saves
 * more than $500 in total interest over the remaining term.
 * Returns { shouldRefinance: boolean, savings: number }.
 */
function refinanceSavings(balance, currentRate, remainingMonths) {
  const lowerRate   = Math.max(0, currentRate - 0.02);
  const currentTotal = calcTotalInterest(balance, currentRate, remainingMonths);
  const lowerTotal   = calcTotalInterest(balance, lowerRate,   remainingMonths);
  const savings      = currentTotal - lowerTotal;
  return { shouldRefinance: savings > 500, savings: parseFloat(savings.toFixed(2)) };
}

/**
 * Given a loan's created_at timestamp, monthly_payment cadence,
 * and the current date, estimate the next payment due date.
 * Assumes monthly payments due on the same calendar day the
 * loan was created.
 */
function nextPaymentDue(createdAt) {
  const created = new Date(createdAt);
  const now     = new Date();
  const due     = new Date(now.getFullYear(), now.getMonth(), created.getDate());
  if (due <= now) {
    due.setMonth(due.getMonth() + 1);
  }
  return due.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Returns true if the given YYYY-MM-DD date string is within
 * the next `days` calendar days.
 */
function isDueWithinDays(dateStr, days = 7) {
  const due  = new Date(dateStr);
  const now  = new Date();
  const diff = (due - now) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= days;
}

// ============================================================
// Auth Middleware
// ============================================================

/**
 * requireAuth — extracts and verifies the Bearer token from
 * the Authorization header.  On success, attaches
 * `req.user` (Supabase user object) and `req.token` (raw JWT)
 * to the request so downstream handlers can use them.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return sendError(res, 401, 'Missing Authorization header. Expected: Bearer <token>');
  }

  try {
    // Use the shared admin client to verify the token against
    // Supabase Auth — this does not require a service-role key.
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return sendError(res, 401, 'Invalid or expired token.', error?.message);
    }
    req.user  = data.user;
    req.token = token;
    next();
  } catch (err) {
    console.error('[auth] token verification threw:', err);
    return sendError(res, 500, 'Authentication service error.');
  }
}

// ============================================================
// Routes — Auth
// ============================================================

/**
 * POST /api/auth/signup
 * Body: { email, password, name, age?, monthly_income? }
 *
 * Creates a Supabase Auth user and then upserts a row in
 * public.users (the database trigger also does this, but we
 * send extra profile fields here).
 */
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, age, monthly_income } = req.body;

  if (!email || !password || !name) {
    return sendError(res, 400, 'email, password, and name are required.');
  }

  try {
    // 1. Create the Auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });

    if (authError) {
      return sendError(res, 400, authError.message);
    }

    const userId = authData.user?.id;
    if (!userId) {
      return sendError(res, 500, 'Signup succeeded but no user ID was returned.');
    }

    // 2. Upsert the extended profile.  The DB trigger already
    //    creates a minimal row; here we add age / income.
    const { error: profileError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: userId,
        name,
        email,
        age:            age            ? parseInt(age, 10)        : null,
        monthly_income: monthly_income ? parseFloat(monthly_income) : null,
      });

    if (profileError) {
      console.warn('[signup] profile upsert error:', profileError.message);
      // Non-fatal — Auth user was created; client can update profile later.
    }

    return res.status(201).json({
      message: 'Signup successful. Check your email to confirm your account.',
      user: {
        id:    userId,
        email: authData.user.email,
        name,
      },
      session: authData.session || null,
    });
  } catch (err) {
    console.error('[signup] unexpected error:', err);
    return sendError(res, 500, 'Internal server error during signup.');
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 *
 * Returns a Supabase session object including access_token and
 * refresh_token.
 */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError(res, 400, 'email and password are required.');
  }

  try {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return sendError(res, 401, error.message);
    }

    return res.status(200).json({
      message: 'Login successful.',
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in:    data.session.expires_in,
        token_type:    data.session.token_type,
        user: {
          id:    data.user.id,
          email: data.user.email,
        },
      },
    });
  } catch (err) {
    console.error('[login] unexpected error:', err);
    return sendError(res, 500, 'Internal server error during login.');
  }
});

// ============================================================
// Routes — Loans
// ============================================================

/**
 * POST /api/loans
 * Headers: Authorization: Bearer <token>
 * Body: { type, label, principal, rate, term_months, balance, monthly_payment }
 *
 * Saves a new loan record for the authenticated user.
 */
app.post('/api/loans', requireAuth, async (req, res) => {
  const { type, label, principal, rate, term_months, balance, monthly_payment } = req.body;

  // Validation
  const validTypes = ['student', 'auto', 'personal', 'business'];
  if (!type || !validTypes.includes(type)) {
    return sendError(res, 400, `type must be one of: ${validTypes.join(', ')}`);
  }
  if (!label || typeof label !== 'string') {
    return sendError(res, 400, 'label is required and must be a string.');
  }
  if (principal == null || isNaN(principal) || Number(principal) <= 0) {
    return sendError(res, 400, 'principal must be a positive number.');
  }
  if (rate == null || isNaN(rate) || Number(rate) < 0) {
    return sendError(res, 400, 'rate must be a non-negative number (e.g. 0.065 for 6.5%).');
  }
  if (!term_months || isNaN(term_months) || Number(term_months) <= 0) {
    return sendError(res, 400, 'term_months must be a positive integer.');
  }
  if (balance == null || isNaN(balance) || Number(balance) < 0) {
    return sendError(res, 400, 'balance must be a non-negative number.');
  }

  // If monthly_payment is not supplied, calculate it from the amortisation formula.
  const computedPayment = monthly_payment != null
    ? parseFloat(monthly_payment)
    : calcMonthlyPayment(parseFloat(principal), parseFloat(rate), parseInt(term_months, 10));

  try {
    const db = buildAuthedClient(req.token);
    const { data, error } = await db
      .from('loans')
      .insert({
        user_id:         req.user.id,
        type,
        label:           label.trim(),
        principal:       parseFloat(principal),
        rate:            parseFloat(rate),
        term_months:     parseInt(term_months, 10),
        balance:         parseFloat(balance),
        monthly_payment: parseFloat(computedPayment.toFixed(2)),
      })
      .select()
      .single();

    if (error) {
      return sendError(res, 400, error.message);
    }

    return res.status(201).json({ message: 'Loan created.', loan: data });
  } catch (err) {
    console.error('[POST /api/loans] error:', err);
    return sendError(res, 500, 'Internal server error while saving loan.');
  }
});

/**
 * GET /api/loans/:userId
 * Headers: Authorization: Bearer <token>
 *
 * Returns all loans for the specified user.  RLS guarantees
 * the authenticated user can only retrieve their own loans.
 */
app.get('/api/loans/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;

  // Extra safety: even if RLS were misconfigured, reject the
  // request if the path userId doesn't match the token owner.
  if (userId !== req.user.id) {
    return sendError(res, 403, 'Forbidden: you may only access your own loans.');
  }

  try {
    const db = buildAuthedClient(req.token);
    const { data, error } = await db
      .from('loans')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return sendError(res, 400, error.message);
    }

    return res.status(200).json({ loans: data });
  } catch (err) {
    console.error('[GET /api/loans/:userId] error:', err);
    return sendError(res, 500, 'Internal server error while fetching loans.');
  }
});

// ============================================================
// Routes — Simulation
// ============================================================

/**
 * POST /api/simulate
 * Headers: Authorization: Bearer <token>
 * Body: { strategy: 'snowball'|'avalanche'|'standard', loans: [...] }
 *
 * Runs a repayment simulation using functions from
 * calculations.js and persists the result.
 */
app.post('/api/simulate', requireAuth, async (req, res) => {
  if (!calcFunctions) {
    return sendError(
      res,
      503,
      'Simulation service unavailable: calculations.js module not found.'
    );
  }

  const { strategy, loans, save = true } = req.body;

  const validStrategies = ['snowball', 'avalanche', 'standard'];
  if (!strategy || !validStrategies.includes(strategy)) {
    return sendError(res, 400, `strategy must be one of: ${validStrategies.join(', ')}`);
  }
  if (!Array.isArray(loans) || loans.length === 0) {
    return sendError(res, 400, 'loans must be a non-empty array of loan objects.');
  }

  try {
    // Determine which calculation function to call.
    // calculations.js is expected to export one or more of:
    //   runSnowball(loans)  → plan object
    //   runAvalanche(loans) → plan object
    //   runStandard(loans)  → plan object
    //   simulate(strategy, loans) → plan object  (generic entry point)
    let planData;

    if (typeof calcFunctions.simulate === 'function') {
      planData = calcFunctions.simulate(strategy, loans);
    } else {
      const fnMap = {
        snowball:  calcFunctions.runSnowball  || calcFunctions.snowball,
        avalanche: calcFunctions.runAvalanche || calcFunctions.avalanche,
        standard:  calcFunctions.runStandard  || calcFunctions.standard,
      };
      const fn = fnMap[strategy];
      if (typeof fn !== 'function') {
        return sendError(
          res,
          501,
          `calculations.js does not export a handler for strategy "${strategy}".`
        );
      }
      planData = fn(loans);
    }

    // Optionally persist the result so users can review it later.
    if (save) {
      const db = buildAuthedClient(req.token);
      await db.from('repayment_plans').insert({
        user_id:   req.user.id,
        strategy,
        plan_data: planData,
      });
    }

    return res.status(200).json({ strategy, plan: planData });
  } catch (err) {
    console.error('[POST /api/simulate] error:', err);
    return sendError(res, 500, 'Internal server error during simulation.');
  }
});

// ============================================================
// Routes — Dashboard
// ============================================================

/**
 * GET /api/dashboard/:userId
 * Headers: Authorization: Bearer <token>
 *
 * Returns a comprehensive dashboard data object:
 * {
 *   user, loans, totalDebt, monthlyPayment, totalInterest,
 *   nextPaymentDue, milestones, notifications
 * }
 *
 * Notification logic:
 *   - Flag loans where payment is due within 7 days.
 *   - Flag loans where refinancing could save >$500.
 */
app.get('/api/dashboard/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (userId !== req.user.id) {
    return sendError(res, 403, 'Forbidden: you may only access your own dashboard.');
  }

  try {
    const db = buildAuthedClient(req.token);

    // Fetch user, loans, and milestones in parallel.
    const [userResult, loansResult, milestonesResult] = await Promise.all([
      db.from('users').select('*').eq('id', userId).single(),
      db.from('loans').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      db.from('milestones').select('*').eq('user_id', userId).order('unlocked_at', { ascending: false }),
    ]);

    if (userResult.error) {
      return sendError(res, 404, 'User not found.', userResult.error.message);
    }
    if (loansResult.error) {
      return sendError(res, 400, 'Failed to fetch loans.', loansResult.error.message);
    }
    if (milestonesResult.error) {
      return sendError(res, 400, 'Failed to fetch milestones.', milestonesResult.error.message);
    }

    const user       = userResult.data;
    const loans      = loansResult.data    || [];
    const milestones = milestonesResult.data || [];

    // ── Aggregates ──────────────────────────────────────────
    const totalDebt     = loans.reduce((sum, l) => sum + parseFloat(l.balance),         0);
    const monthlyPayment = loans.reduce((sum, l) => sum + parseFloat(l.monthly_payment), 0);
    const totalInterest  = loans.reduce((sum, l) => {
      const remaining = Math.round(parseFloat(l.balance) / parseFloat(l.monthly_payment));
      return sum + calcTotalInterest(
        parseFloat(l.balance),
        parseFloat(l.rate),
        Math.max(1, remaining)
      );
    }, 0);

    // ── Next payment due (earliest across all loans) ────────
    const paymentDates = loans.map((l) => nextPaymentDue(l.created_at));
    const earliestDue  = paymentDates.length > 0
      ? paymentDates.sort()[0]
      : null;

    // ── Notifications ───────────────────────────────────────
    const notifications = [];

    loans.forEach((loan) => {
      const dueDate = nextPaymentDue(loan.created_at);

      // Payment due within 7 days
      if (isDueWithinDays(dueDate, 7)) {
        notifications.push({
          type:    'payment_due',
          loanId:  loan.id,
          label:   loan.label,
          dueDate,
          amount:  parseFloat(loan.monthly_payment),
          message: `Payment of $${parseFloat(loan.monthly_payment).toFixed(2)} for "${loan.label}" is due on ${dueDate}.`,
        });
      }

      // Refinancing opportunity
      const remainingMonths = Math.max(
        1,
        Math.round(parseFloat(loan.balance) / parseFloat(loan.monthly_payment))
      );
      const { shouldRefinance, savings } = refinanceSavings(
        parseFloat(loan.balance),
        parseFloat(loan.rate),
        remainingMonths
      );
      if (shouldRefinance) {
        notifications.push({
          type:    'refinance_opportunity',
          loanId:  loan.id,
          label:   loan.label,
          savings,
          message: `Refinancing "${loan.label}" at a 2% lower rate could save you $${savings.toFixed(2)} in total interest.`,
        });
      }
    });

    // ── Response ────────────────────────────────────────────
    return res.status(200).json({
      user: {
        id:    user.id,
        name:  user.name,
        email: user.email,
      },
      loans,
      totalDebt:      parseFloat(totalDebt.toFixed(2)),
      monthlyPayment: parseFloat(monthlyPayment.toFixed(2)),
      totalInterest:  parseFloat(totalInterest.toFixed(2)),
      nextPaymentDue: earliestDue,
      milestones,
      notifications,
    });
  } catch (err) {
    console.error('[GET /api/dashboard/:userId] error:', err);
    return sendError(res, 500, 'Internal server error while building dashboard.');
  }
});

// ============================================================
// Routes — AI Advice
// ============================================================

/**
 * POST /api/ai/advice
 * Headers: Authorization: Bearer <token>
 * Body: { age?, income?, loans? }
 *
 * Fetches the user's profile and loans from Supabase (falling
 * back to any values supplied in the request body), constructs
 * a prompt, calls Claude claude-haiku-4-5-20251001, and returns the
 * personalized recommendation.
 */
app.post('/api/ai/advice', requireAuth, async (req, res) => {
  const db = buildAuthedClient(req.token);

  try {
    // 1. Fetch user profile and loans.
    const [userResult, loansResult] = await Promise.all([
      db.from('users').select('*').eq('id', req.user.id).single(),
      db.from('loans').select('*').eq('user_id', req.user.id),
    ]);

    const userRow  = userResult.data  || {};
    const dbLoans  = loansResult.data || [];

    // Allow the caller to supplement or override with body values.
    const age     = req.body.age    ?? userRow.age            ?? 'unknown';
    const income  = req.body.income ?? userRow.monthly_income ?? 'unknown';
    const loans   = (req.body.loans && req.body.loans.length > 0)
      ? req.body.loans
      : dbLoans;

    if (loans.length === 0) {
      return sendError(
        res,
        400,
        'No loans found for this user. Add at least one loan before requesting AI advice.'
      );
    }

    // 2. Build the prompt.
    const loansJson = JSON.stringify(
      loans.map((l) => ({
        type:           l.type,
        label:          l.label,
        balance:        parseFloat(l.balance),
        rate:           `${(parseFloat(l.rate) * 100).toFixed(2)}%`,
        monthly_payment: parseFloat(l.monthly_payment),
        term_months:    l.term_months,
      })),
      null,
      2
    );

    const incomeDisplay = income !== 'unknown'
      ? `$${parseFloat(income).toFixed(2)}/month`
      : 'unknown';

    const prompt = [
      'You are a financial advisor for young adults. The user has the following loan profile:',
      `- Age: ${age}`,
      `- Monthly income estimate: ${incomeDisplay}`,
      `- Loans: ${loansJson}`,
      '',
      'Give a 2-3 sentence personalized recommendation on their best repayment strategy.',
      'Be direct and actionable. Do not use jargon.',
    ].join('\n');

    // 3. Call Claude claude-haiku-4-5-20251001.
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        { role: 'user', content: prompt },
      ],
    });

    const advice = response.content
      .filter((block) => block.type === 'text')
      .map((block)   => block.text)
      .join('\n')
      .trim();

    // 4. Unlock the ai_advisor milestone if not already unlocked.
    await db.from('milestones').upsert(
      { user_id: req.user.id, milestone_key: 'ai_advisor' },
      { onConflict: 'user_id,milestone_key', ignoreDuplicates: true }
    );

    return res.status(200).json({
      advice,
      model:           'claude-haiku-4-5-20251001',
      prompt_tokens:   response.usage?.input_tokens  ?? null,
      response_tokens: response.usage?.output_tokens ?? null,
    });
  } catch (err) {
    console.error('[POST /api/ai/advice] error:', err);
    // Surface Anthropic API errors with a more helpful message.
    if (err?.status && err?.error) {
      return sendError(res, 502, 'AI service error.', err.error?.error?.message ?? err.message);
    }
    return sendError(res, 500, 'Internal server error while generating AI advice.');
  }
});

// ============================================================
// Health check
// ============================================================

app.get('/health', (_req, res) => {
  res.status(200).json({
    status:    'ok',
    service:   'lifelaunch-backend',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// 404 catch-all
// ============================================================

app.use((req, res) => {
  sendError(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
});

// ============================================================
// Global error handler
// ============================================================

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  sendError(res, 500, 'An unexpected error occurred.', err.message);
});

// ============================================================
// Start server
// ============================================================

app.listen(PORT, () => {
  console.log(`[LifeLaunch] Backend API listening on http://localhost:${PORT}`);
  console.log('[LifeLaunch] Supabase URL:', SUPABASE_URL);
  console.log('[LifeLaunch] Environment:', process.env.NODE_ENV || 'development');
});

module.exports = app; // exported for testing

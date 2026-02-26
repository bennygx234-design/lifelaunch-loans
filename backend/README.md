# LifeLaunch Loans — Backend API

Express.js REST API that powers the LifeLaunch Loans application. Connects to Supabase (PostgreSQL + Auth) for data persistence and the Anthropic API (Claude) for AI-powered financial advice.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setup](#setup)
3. [Environment Variables](#environment-variables)
4. [Running the Server](#running-the-server)
5. [Database Setup](#database-setup)
6. [API Reference](#api-reference)
   - [Health Check](#health-check)
   - [Auth — Signup](#post-apiauthsignup)
   - [Auth — Login](#post-apiauthlogin)
   - [Loans — Create](#post-apiloans)
   - [Loans — List](#get-apiloansuserId)
   - [Simulate Repayment](#post-apisimulate)
   - [Dashboard](#get-apidashboarduserId)
   - [AI Advice](#post-apiai-advice)
7. [Error Responses](#error-responses)
8. [Notification Logic](#notification-logic)
9. [Milestone Keys](#milestone-keys)

---

## Prerequisites

- Node.js >= 18
- A [Supabase](https://supabase.com) project (free tier works)
- An [Anthropic](https://console.anthropic.com) API key

---

## Setup

```bash
# 1. Navigate to the backend directory
cd lifelaunch/backend

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Open .env and fill in SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY

# 4. Run the database schema (see Database Setup below)

# 5. Start the development server
npm run dev
```

---

## Environment Variables

| Variable           | Required | Description                                           |
|--------------------|----------|-------------------------------------------------------|
| `SUPABASE_URL`     | Yes      | Supabase project URL (Settings → API)                 |
| `SUPABASE_ANON_KEY`| Yes      | Supabase anon/public key (Settings → API)             |
| `ANTHROPIC_API_KEY`| Yes      | Anthropic API key (console.anthropic.com)             |
| `PORT`             | No       | TCP port (default: `3001`)                            |
| `CORS_ORIGIN`      | No       | Allowed CORS origin(s) (default: `*`)                 |
| `NODE_ENV`         | No       | `development` or `production`                         |

---

## Running the Server

```bash
# Production
npm start

# Development (auto-reload with nodemon)
npm run dev
```

The server will log its address on startup:

```
[LifeLaunch] Backend API listening on http://localhost:3001
```

---

## Database Setup

1. Open your Supabase project dashboard.
2. Go to **SQL Editor** → **New Query**.
3. Paste the contents of `schema.sql` and click **Run**.

The schema creates four tables (`users`, `loans`, `milestones`, `repayment_plans`), all necessary indexes, RLS policies, and a database trigger that automatically creates a `public.users` row when a new Auth user signs up.

---

## API Reference

All authenticated endpoints require:

```
Authorization: Bearer <access_token>
```

The `access_token` is returned by the login endpoint.

---

### Health Check

```
GET /health
```

Returns server status. No authentication required.

**Example**

```bash
curl http://localhost:3001/health
```

**Response `200`**

```json
{
  "status": "ok",
  "service": "lifelaunch-backend",
  "timestamp": "2026-02-26T12:00:00.000Z"
}
```

---

### POST /api/auth/signup

Create a new user account.

**Request Body**

| Field            | Type    | Required | Description                     |
|------------------|---------|----------|---------------------------------|
| `email`          | string  | Yes      | User's email address            |
| `password`       | string  | Yes      | Password (min 6 chars)          |
| `name`           | string  | Yes      | Display name                    |
| `age`            | number  | No       | User's age                      |
| `monthly_income` | number  | No       | Estimated monthly income in USD |

**Example**

```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "jordan@example.com",
    "password": "SecurePass123!",
    "name": "Jordan Smith",
    "age": 24,
    "monthly_income": 3800
  }'
```

**Response `201`**

```json
{
  "message": "Signup successful. Check your email to confirm your account.",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "jordan@example.com",
    "name": "Jordan Smith"
  },
  "session": {
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "expires_in": 3600,
    "token_type": "bearer"
  }
}
```

> If email confirmation is enabled in Supabase, `session` will be `null` until the user confirms their email.

---

### POST /api/auth/login

Authenticate and receive a session token.

**Request Body**

| Field      | Type   | Required |
|------------|--------|----------|
| `email`    | string | Yes      |
| `password` | string | Yes      |

**Example**

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "jordan@example.com",
    "password": "SecurePass123!"
  }'
```

**Response `200`**

```json
{
  "message": "Login successful.",
  "session": {
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "expires_in": 3600,
    "token_type": "bearer",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "jordan@example.com"
    }
  }
}
```

Store the `access_token` and send it as `Authorization: Bearer <access_token>` in all subsequent requests.

---

### POST /api/loans

Save a new loan for the authenticated user.

**Headers:** `Authorization: Bearer <token>`

**Request Body**

| Field            | Type    | Required | Description                                             |
|------------------|---------|----------|---------------------------------------------------------|
| `type`           | string  | Yes      | `student`, `auto`, `personal`, or `business`            |
| `label`          | string  | Yes      | Human-readable name (e.g. "Sallie Mae Undergraduate")   |
| `principal`      | number  | Yes      | Original loan amount in USD                             |
| `rate`           | number  | Yes      | Annual interest rate as a decimal (`0.065` = 6.5%)      |
| `term_months`    | number  | Yes      | Loan term in months                                     |
| `balance`        | number  | Yes      | Current outstanding balance in USD                      |
| `monthly_payment`| number  | No       | Monthly payment amount (calculated automatically if omitted) |

**Example**

```bash
curl -X POST http://localhost:3001/api/loans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "type": "student",
    "label": "Sallie Mae Undergraduate",
    "principal": 28000,
    "rate": 0.065,
    "term_months": 120,
    "balance": 24500
  }'
```

**Response `201`**

```json
{
  "message": "Loan created.",
  "loan": {
    "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "student",
    "label": "Sallie Mae Undergraduate",
    "principal": 28000,
    "rate": 0.065,
    "term_months": 120,
    "balance": 24500,
    "monthly_payment": 316.80,
    "created_at": "2026-02-26T12:00:00.000Z"
  }
}
```

---

### GET /api/loans/:userId

Retrieve all loans for a user.

**Headers:** `Authorization: Bearer <token>`

**Path Parameters**

| Parameter | Description                         |
|-----------|-------------------------------------|
| `userId`  | UUID of the user (must match token) |

**Example**

```bash
curl http://localhost:3001/api/loans/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer <access_token>"
```

**Response `200`**

```json
{
  "loans": [
    {
      "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "user_id": "550e8400-e29b-41d4-a716-446655440000",
      "type": "student",
      "label": "Sallie Mae Undergraduate",
      "principal": 28000,
      "rate": 0.065,
      "term_months": 120,
      "balance": 24500,
      "monthly_payment": 316.80,
      "created_at": "2026-02-26T12:00:00.000Z"
    },
    {
      "id": "7ba7b810-9dad-11d1-80b4-00c04fd430c9",
      "user_id": "550e8400-e29b-41d4-a716-446655440000",
      "type": "auto",
      "label": "Toyota Financing",
      "principal": 18500,
      "rate": 0.049,
      "term_months": 60,
      "balance": 12000,
      "monthly_payment": 348.52,
      "created_at": "2026-02-20T09:00:00.000Z"
    }
  ]
}
```

---

### POST /api/simulate

Run a repayment simulation using the strategy engine in `calculations.js`.

**Headers:** `Authorization: Bearer <token>`

**Request Body**

| Field      | Type    | Required | Description                                            |
|------------|---------|----------|--------------------------------------------------------|
| `strategy` | string  | Yes      | `snowball`, `avalanche`, or `standard`                 |
| `loans`    | array   | Yes      | Array of loan objects to simulate                      |
| `save`     | boolean | No       | Persist the plan to `repayment_plans` table (default: `true`) |

**Example**

```bash
curl -X POST http://localhost:3001/api/simulate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "strategy": "avalanche",
    "loans": [
      {
        "id": "loan-1",
        "label": "Sallie Mae",
        "balance": 24500,
        "rate": 0.065,
        "term_months": 120,
        "monthly_payment": 316.80
      },
      {
        "id": "loan-2",
        "label": "Toyota Financing",
        "balance": 12000,
        "rate": 0.049,
        "term_months": 60,
        "monthly_payment": 348.52
      }
    ],
    "save": true
  }'
```

**Response `200`**

```json
{
  "strategy": "avalanche",
  "plan": {
    "totalMonths": 102,
    "totalInterestPaid": 8432.17,
    "payoffOrder": ["loan-1", "loan-2"],
    "schedule": [...]
  }
}
```

> The exact shape of `plan` depends on the implementation in `../calculations.js`.

---

### GET /api/dashboard/:userId

Returns the complete dashboard data object for a user, including aggregated totals, notifications, and milestones.

**Headers:** `Authorization: Bearer <token>`

**Path Parameters**

| Parameter | Description                         |
|-----------|-------------------------------------|
| `userId`  | UUID of the user (must match token) |

**Example**

```bash
curl http://localhost:3001/api/dashboard/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer <access_token>"
```

**Response `200`**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Jordan Smith",
    "email": "jordan@example.com"
  },
  "loans": [
    {
      "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "type": "student",
      "label": "Sallie Mae Undergraduate",
      "balance": 24500,
      "monthly_payment": 316.80,
      "rate": 0.065,
      "term_months": 120
    }
  ],
  "totalDebt": 36500,
  "monthlyPayment": 665.32,
  "totalInterest": 9841.56,
  "nextPaymentDue": "2026-03-01",
  "milestones": [
    {
      "id": 1,
      "user_id": "550e8400-e29b-41d4-a716-446655440000",
      "milestone_key": "first_payment",
      "unlocked_at": "2026-02-01T00:00:00.000Z"
    }
  ],
  "notifications": [
    {
      "type": "payment_due",
      "loanId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "label": "Sallie Mae Undergraduate",
      "dueDate": "2026-03-01",
      "amount": 316.80,
      "message": "Payment of $316.80 for \"Sallie Mae Undergraduate\" is due on 2026-03-01."
    },
    {
      "type": "refinance_opportunity",
      "loanId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "label": "Sallie Mae Undergraduate",
      "savings": 1243.50,
      "message": "Refinancing \"Sallie Mae Undergraduate\" at a 2% lower rate could save you $1243.50 in total interest."
    }
  ]
}
```

**Notification types**

| `type`                  | Description                                                      |
|-------------------------|------------------------------------------------------------------|
| `payment_due`           | A loan payment is due within the next 7 calendar days.          |
| `refinance_opportunity` | Refinancing at 2% lower rate saves more than $500 in interest.  |

---

### POST /api/ai/advice

Sends the user's loan profile to Claude claude-haiku-4-5-20251001 and returns a 2-3 sentence personalized repayment recommendation.

**Headers:** `Authorization: Bearer <token>`

**Request Body** (all fields are optional — the server fetches the data from Supabase if not provided)

| Field    | Type   | Description                                                    |
|----------|--------|----------------------------------------------------------------|
| `age`    | number | User's age (overrides database value)                          |
| `income` | number | Monthly income in USD (overrides database value)               |
| `loans`  | array  | Array of loan objects (overrides database loans if provided)   |

**Example — using stored profile (most common)**

```bash
curl -X POST http://localhost:3001/api/ai/advice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{}'
```

**Example — providing explicit data**

```bash
curl -X POST http://localhost:3001/api/ai/advice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "age": 26,
    "income": 4200,
    "loans": [
      {
        "type": "student",
        "label": "Federal Direct Subsidized",
        "balance": 18000,
        "rate": 0.0499,
        "monthly_payment": 190.00,
        "term_months": 120
      },
      {
        "type": "personal",
        "label": "SoFi Personal Loan",
        "balance": 6500,
        "rate": 0.1199,
        "monthly_payment": 215.00,
        "term_months": 36
      }
    ]
  }'
```

**Response `200`**

```json
{
  "advice": "With your personal loan carrying a 12% interest rate, you should throw every extra dollar at that one first while making minimum payments on your student loan — this is the avalanche method and it will save you the most money overall. Once the personal loan is gone in about 2.5 years, roll that $215 payment into your student loan to pay it off years ahead of schedule. Even an extra $50 a month toward your highest-rate debt right now will make a significant dent.",
  "model": "claude-haiku-4-5-20251001",
  "prompt_tokens": 148,
  "response_tokens": 97
}
```

---

## Error Responses

All errors follow a consistent shape:

```json
{
  "error": "Human-readable error message.",
  "details": "Optional additional detail string."
}
```

| Status | Meaning                                        |
|--------|------------------------------------------------|
| `400`  | Bad request — missing or invalid parameters    |
| `401`  | Unauthorized — missing or invalid token        |
| `403`  | Forbidden — token does not match resource      |
| `404`  | Not found — route or resource does not exist   |
| `500`  | Internal server error                          |
| `502`  | Bad gateway — upstream AI service error        |
| `503`  | Service unavailable — calculations module missing |

---

## Notification Logic

The dashboard endpoint applies two notification rules to each loan:

**Payment Due Within 7 Days**
The server estimates the next payment date by assuming payments fall on the same day of the month the loan was created. If that date is within the next 7 calendar days, a `payment_due` notification is emitted.

**Refinancing Opportunity**
Using the standard amortisation formula, the server computes total interest paid under the current rate and under a hypothetical rate 2 percentage points lower. If the savings exceed $500, a `refinance_opportunity` notification is emitted.

---

## Milestone Keys

Milestones are unlocked programmatically by the application layer. The following keys are defined:

| Key                   | Description                                        |
|-----------------------|----------------------------------------------------|
| `first_payment`       | User makes their first loan payment                |
| `half_paid`           | Any single loan reaches 50% paid off               |
| `paid_off_one`        | First loan fully paid off (balance = 0)            |
| `three_months_streak` | Three consecutive on-time payments                 |
| `debt_free`           | All loans have zero balance                        |
| `snowball_starter`    | User runs their first snowball simulation          |
| `avalanche_starter`   | User runs their first avalanche simulation         |
| `ai_advisor`          | User receives their first AI advice recommendation |

The `ai_advisor` milestone is automatically unlocked by the `/api/ai/advice` endpoint on first use.

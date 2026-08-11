# PowerSnap

PowerSnap is a friction-free CSV cleanup funnel:

**Upload → instant business-risk audit → one-click fix → paid clean-file download.**

No registration is required to see the audit or apply the first fix.

## What is different from the rough blueprint

- Pandas measures real issues and counts first; the AI cannot invent executable fixes.
- Raw customer rows are not sent to OpenAI. The model sees headers, aggregate column profiles, and format signatures.
- OpenAI Structured Outputs constrains the response to an allow-list of safe cleanup actions.
- Files use random expiring sessions instead of a global `LAST_ANALYZED_DATA` dictionary or fixed filename.
- Download authorization is bound to a completed Stripe Checkout session and uses a short-lived signed URL.
- Date cleanup preserves values it cannot safely parse instead of silently converting them to missing data.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --port 8000
```

Open `http://localhost:8000`.

`OPENAI_API_KEY` is optional for local QA because a deterministic fallback audit is included. Set `DOWNLOAD_SIGNING_SECRET` for download tests. Stripe variables are required only for real checkout.

## Environment variables

- `OPENAI_API_KEY` — enables AI-written business framing.
- `OPENAI_MODEL` — defaults to `gpt-4o-mini`.
- `DOWNLOAD_SIGNING_SECRET` — signs paid download links.
- `STRIPE_SECRET_KEY` — Stripe server key.
- `STRIPE_PRICE_ID` — recurring $49/month Price ID.
- `FRONTEND_URL` — checkout return origin.
- `CORS_ORIGINS` — comma-separated allowed origins.
- `MAX_UPLOAD_MB` — defaults to 20.
- `SESSION_TTL_SECONDS` — defaults to 3600.
- `POWERSNAP_DEV_UNLOCK_KEY` — optional QA-only unlock bypass; never expose it client-side.

## Deploy

The included Dockerfile deploys the entire product as one FastAPI container, including the frontend. Railway, Render, Fly.io, or another container host can run it directly.

The MVP stores uploaded files in an expiring temporary directory. Before horizontal scaling, replace that file store with private object storage so paid downloads survive restarts and can be served by any instance.

## Current cleanup actions

- trim leading/trailing whitespace
- normalize email casing/whitespace
- standardize phone values to digits
- normalize parseable dates to `YYYY-MM-DD`
- remove duplicates on likely business keys
- remove fully empty rows

## Validate

```bash
PYTHONPATH=. pytest -q
```

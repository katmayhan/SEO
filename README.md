# Baboodle search brain

SEO and AEO dashboard for baboodle.co.uk, hosted at https://baboodleseo.netlify.app (password protected).

## What runs when
| Job | When | What it does |
|---|---|---|
| `cron-daily` → `gsc-sync-background` | 05:40 UTC daily | Search Console site, page and page+query data per day (first run backfills 90 days) |
| `cron-weekly` → `site-scan-background` → `aeo-check-background` → `analyze-background` | Monday 06:20 UTC | Crawl the sitemap, ask Claude the parent questions with web search, then write suggestions, blog ideas with strategy and alt text, and measure changes marked done 28+ days ago |
| `draft-blog-background` | On demand | Writes a blog draft from an idea |

## Environment variables (Netlify)
SUPABASE_URL, SUPABASE_SERVICE_KEY, GSC_CLIENT_ID, GSC_CLIENT_SECRET, ANTHROPIC_API_KEY, DASHBOARD_URL, DASHBOARD_PASSWORD, JOB_SECRET.
Optional: SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN, SHOPIFY_BLOG_ID (to send blog drafts to Shopify unpublished), CLAUDE_MODEL, CLAUDE_MODEL_FAST, BOOKING_RATE.

No secrets live in this repo. The database (Supabase project "SEO") has row-level security on with no public policies: only the Netlify functions, using the service key, can read or write it.

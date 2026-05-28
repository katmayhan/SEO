# Baboodle SEO & AEO Dashboard

A live SEO dashboard for baboodle.co.uk — pulls real data from Google Search Console, tracks changes and their impact, and uses Claude AI to proactively surface optimisation opportunities.

## What it does

- **Live GSC data** — clicks, impressions, CTR, and position per page, synced daily
- **Query drill-down** — click any page to see every search term driving traffic to it
- **AI analysis** — Claude analyses your data and flags specific opportunities proactively
- **Action plan** — AI-suggested actions move through: Suggested → Planned → Actioned → Measuring → Complete
- **Change tracking** — when you click "Actioned", a before-snapshot is taken; after 28 days Claude measures the impact
- **Content plan** — AI-generated content briefs targeting your keyword gaps
- **AEO tracking** — monitors which AI search queries Baboodle should appear in

---

## Setup — step by step

### 1. Clone and install

```bash
git clone https://github.com/your-org/baboodle-seo-dashboard.git
cd baboodle-seo-dashboard
npm install
```

### 2. Create Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Name it "baboodle-seo-dashboard"
3. Once created, go to **SQL Editor** and run the contents of `supabase/schema.sql`
4. Copy your project URL and API keys from **Settings → API**

### 3. Set up Google Cloud OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project: "Baboodle SEO Dashboard"
3. Enable the **Google Search Console API**
4. Go to **APIs & Services → Credentials → Create OAuth 2.0 Client ID**
   - Application type: Web application
   - Authorised JavaScript origins: `https://your-netlify-url.netlify.app`
   - Authorised redirect URIs: `https://your-netlify-url.netlify.app/auth/callback`
5. Go to **OAuth consent screen**
   - Set External, fill in app name
   - Add scope: `https://www.googleapis.com/auth/webmasters.readonly`
   - Add your Google account as a test user

### 4. Get Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Copy it — you'll need it for the `ANTHROPIC_API_KEY` env variable

### 5. Configure environment variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

Update `public/index.html` — find these two lines near the top of the `<script>` block and replace with your real values:
```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

### 6. Deploy to Netlify

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login
netlify login

# Create new site
netlify init

# Set environment variables (or add them in Netlify dashboard)
netlify env:set SUPABASE_URL "https://your-project.supabase.co"
netlify env:set SUPABASE_SERVICE_KEY "your-service-key"
netlify env:set GSC_CLIENT_ID "your-client-id.apps.googleusercontent.com"
netlify env:set GSC_CLIENT_SECRET "your-client-secret"
netlify env:set ANTHROPIC_API_KEY "sk-ant-your-key"
netlify env:set DASHBOARD_URL "https://your-site.netlify.app"

# Deploy
netlify deploy --prod
```

### 7. Connect to GitHub

```bash
git remote add origin https://github.com/your-org/baboodle-seo-dashboard.git
git push -u origin main
```

Then in Netlify dashboard → Site settings → Build & deploy → Link to GitHub repo. Auto-deploys on every push.

### 8. Authenticate GSC

1. Open your deployed dashboard URL
2. Click "Sign in with Google"
3. Approve access for baboodle.co.uk
4. You'll be redirected back — the dashboard will start pulling data

### 9. Trigger first sync

Click "Sync now" in the sidebar, or wait for the 6am UTC scheduled sync to run automatically.

---

## How the action workflow works

```
1. AI generates suggestions (or you add manually)
2. Review suggestions → click "Add to plan"
3. Make the change on your Shopify/website
4. Click "Mark actioned ✓" in the dashboard
   → Before-snapshot taken automatically
   → 28-day measurement window starts
5. Dashboard tracks GSC metrics daily
6. After 28 days → Claude writes impact report
   → Position before/after, CTR before/after, click delta
```

---

## Scheduled functions (automatic)

| Function | Schedule | What it does |
|---|---|---|
| `gsc-sync` | 6am UTC daily | Pulls GSC data for last 3 days |
| `measure-impact` | 7am UTC daily | Checks completed action measurement windows and writes impact reports |

---

## File structure

```
baboodle-seo-dashboard/
├── public/
│   ├── index.html          # Main dashboard
│   └── auth-callback.html  # OAuth callback page
├── netlify/
│   └── functions/
│       ├── gsc-auth.js     # OAuth flow handler
│       ├── gsc-sync.js     # Daily GSC data sync
│       ├── crawl-page.js   # Page snapshot crawler
│       └── measure-impact.js # Impact measurement
├── supabase/
│   └── schema.sql          # Full database schema
├── .env.example            # Environment variable template
├── netlify.toml            # Netlify config + cron schedules
└── package.json
```

# 🚀 Deployment Guide

## Step 1: Create GitHub Repository

1. Go to [GitHub](https://github.com/new)
2. Fill in the details:
   - **Repository name**: `yt-promo-finder` (or your preferred name)
   - **Description**: "YouTube Channel Promotion Finder - Discover product promotions from any YouTube channel"
   - **Visibility**: Choose Public or Private
   - ⚠️ **DO NOT** initialize with README, .gitignore, or license (we already have these)
3. Click **Create repository**

## Step 2: Push Your Code to GitHub

After creating the repo, run these commands in your terminal:

```bash
cd "/Users/davidjwoodbury/yt promo finder"
git remote add origin https://github.com/YOUR_USERNAME/yt-promo-finder.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 3: Deploy to Vercel (Recommended - Easiest)

### Option A: Deploy via Vercel Website
1. Go to [Vercel](https://vercel.com)
2. Click **"Add New Project"**
3. Import your GitHub repository
4. Configure:
   - **Framework Preset**: Other
   - **Build Command**: (leave empty)
   - **Output Directory**: public
   - **Install Command**: npm install
5. Add Environment Variables:
   - Key: `YOUTUBE_API_KEY`
   - Value: Your YouTube API key
6. Click **Deploy**
7. Done! Your site will be live at `https://your-project.vercel.app`

### Option B: Deploy via Vercel CLI
```bash
npm i -g vercel
vercel
# Follow the prompts
# Add YOUTUBE_API_KEY when prompted
```

## Step 4: Alternative Deployment Options

### Deploy to Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name**: yt-promo-finder
   - **Environment**: Node
   - **Build Command**: npm install
   - **Start Command**: npm start
5. Add Environment Variable:
   - Key: `YOUTUBE_API_KEY`
   - Value: Your API key
6. Click **Create Web Service**

### Deploy to Railway

1. Go to [Railway](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your repository
4. Railway will auto-detect Node.js
5. Add Environment Variables in Settings:
   - `YOUTUBE_API_KEY`: Your API key
6. Click **Deploy**

### Deploy to Heroku

```bash
# Install Heroku CLI first
heroku create yt-promo-finder
heroku config:set YOUTUBE_API_KEY=your_api_key_here
git push heroku main
heroku open
```

## 📝 Important Notes

- ✅ Always set `YOUTUBE_API_KEY` in your deployment platform
- ✅ Never commit your `.env` file to GitHub
- ✅ Use the `.env.example` file as a template for other developers
- ✅ Monitor your YouTube API quota in [Google Cloud Console](https://console.cloud.google.com)

## 🔗 Setting Up Redis Storage (Recommended for Production)

For persistent quota tracking across serverless invocations, set up Upstash Redis:

### Option A: Via Vercel Marketplace (Easiest)
1. Go to your Vercel project dashboard
2. Click **Storage** → **Browse Storage** → Select **Upstash Redis**
3. Follow the setup wizard
4. Vercel will automatically add the required environment variables

### Option B: Direct Upstash Setup
1. Go to [Upstash Console](https://console.upstash.com/)
2. Create a new Redis database
3. Add these environment variables to your Vercel project:
   - `UPSTASH_REDIS_REST_URL` - Your Upstash REST URL
   - `UPSTASH_REDIS_REST_TOKEN` - Your Upstash REST token

Without Redis storage, quota tracking will reset between serverless function invocations (which could lead to exceeding YouTube API limits).

## �🔧 Troubleshooting

### Build fails on deployment
- Ensure `package.json` has correct scripts
- Check Node.js version (should be >=18)

### API not working after deployment
- Verify `YOUTUBE_API_KEY` is set in environment variables
- Check API key is valid and YouTube Data API v3 is enabled

### 404 errors
- Ensure the deployment platform is serving from the correct directory
- Check that `public` folder is included in deployment

## Research pages and email signup

Public pages are static HTML in `public`; `server.js` serves them locally and `vercel.json` maps production clean URLs. Guide articles use directory `index.html` files plus explicit production rewrites. The homepage retains the original sponsor analyzer below its research landing sections.

After UI/content changes, run `npm run build:css` and `npm test`. The SEO tests cover every static page's metadata, internal links, heading structure, sitemap membership, guide lengths, and FAQ schema. Private dashboards and transaction confirmations remain `noindex` and are excluded from the sitemap.

The homepage and Unlisted Finder use `public/newsletter.js` to POST opt-in signups to `https://formsubmit.co/ajax/promofinder@4ourmedia.com`. The native form action works without JavaScript. Production CSP permits only this provider origin in addition to existing connections. Submissions include email, consent, source, and mail formatting fields, not search inputs/results. Success is shown only after FormSubmit confirms acceptance; delivery is not guaranteed by an HTTP success.

**Inbox activation:** FormSubmit requires the inbox owner to follow its activation email before forwarding signups. Confirm activation and send a controlled signup from the live site to verify delivery. Browser/tests use synthetic requests and do not send real signup emails. This integration captures consent and delivers signup requests; it does not create an automated mailing list or send campaigns. Manage removal requests at promofinder@4ourmedia.com as described in the privacy policy.

SoftwareApplication structured data includes the accurate free-preview offer; no aggregate rating is published without verified review data. The WebSite SearchAction pre-fills the channel field on `/unlisted`; the visitor still explicitly runs the search. Usage statistics on the homepage are labeled with their reporting dates and are not search counts or testimonials.

## 🎉 Success!

Once deployed, your app will be live and accessible via a public URL. Share it with the world! 🌍

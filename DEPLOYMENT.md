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

## 🔧 Troubleshooting

### Build fails on deployment
- Ensure `package.json` has correct scripts
- Check Node.js version (should be >=18)

### API not working after deployment
- Verify `YOUTUBE_API_KEY` is set in environment variables
- Check API key is valid and YouTube Data API v3 is enabled

### 404 errors
- Ensure the deployment platform is serving from the correct directory
- Check that `public` folder is included in deployment

## 🎉 Success!

Once deployed, your app will be live and accessible via a public URL. Share it with the world! 🌍

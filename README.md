# 🎯 YouTube Promo Finder

A comprehensive suite of YouTube channel analysis tools to discover sponsorships, affiliate links, brand deals, collaborations, and more. Analyze 12 months of video data instantly.

**🌐 Live at: [promofinder.4ourmedia.com](https://promofinder.4ourmedia.com)**

![YouTube Promo Finder](https://img.shields.io/badge/YouTube-API-red?style=for-the-badge&logo=youtube)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)

## ✨ Features

### 🔍 Promotion Finder (Main Tool)
- Analyzes the last 12 months of video uploads
- Identifies product links, affiliate codes, and sponsorships from video descriptions
- Groups promotions by domain with mention counts
- Export results to CSV or JSON

### 🌐 Domain Search
- Search for any brand/website across YouTube
- Find every video that mentions a specific domain
- Perfect for competitive research and brand monitoring

### 👁️ Unlisted Video Finder
- Discover unlisted videos from any channel
- Finds unlisted video URLs shared in other video descriptions
- Useful for finding hidden content

### 🎵 TikTok Downloader
- Download TikTok videos from public URLs
- Save no-watermark video when available
- Export audio track as MP3-compatible download

### 📈 Growth Tracker
- Analyze channel statistics and upload patterns
- See posting schedules and upload frequency
- Track content output over time

### 🤝 Collaboration Finder
- Map creator networks and partnerships
- Find channel mentions in video descriptions
- Discover collaboration patterns

### 🔀 Compare Sponsors
- Compare sponsorships across multiple channels
- Find common brand partnerships
- Identify unique sponsorship deals

### 💰 Sponsorship Rate Estimator
- Estimate what a creator might charge for sponsored content
- Calculate rates based on views, engagement, and niche
- Compare sponsored vs non-sponsored video performance
- Niche-specific CPM rates (tech, gaming, finance, lifestyle, etc.)

### 🔥 Viral Video Detector
- Identify videos that significantly outperformed channel average
- Categorize videos (mega-viral, viral, hit, above-average, flop)
- Analyze viral patterns (keywords, posting times, title lengths)
- Find common elements in successful content

### 📊 Sponsor Saturation Score
- Measure how heavily a channel is monetized
- Grade channels from A (light) to F (over-saturated)
- Track sponsorship trend over time (increasing/decreasing)
- Assess audience fatigue risk for brand partnerships
- Identify top recurring sponsors

### General Features
- 🎨 **Modern UI** - Beautiful, responsive design with glass morphism effects
- 📋 **Copy to Clipboard** - Easy copying of promotion URLs
- ⚡ **Fast & Cached** - In-memory caching for quick repeated searches
- 📱 **Mobile Friendly** - Fully responsive design
- 📊 **Export Data** - Download results as CSV or JSON
- 🔄 **Quota Management** - Real-time API quota tracking and display

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- YouTube Data API v3 Key

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/yt-promo-finder.git
   cd yt-promo-finder
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   
   Create a `.env` file in the root directory:
   ```env
   YOUTUBE_API_KEY=your_youtube_api_key_here
   PORT=3000
   ```

   To get a YouTube API key:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Enable the YouTube Data API v3
   - Create credentials (API Key)
   - Copy the API key to your `.env` file

4. **Start the server**
   ```bash
   npm start
   ```

5. **Open your browser**
   
   Navigate to `http://localhost:3000`

## 📖 Usage

### Promotion Finder
1. Enter a YouTube channel URL in any of these formats:
   - `https://www.youtube.com/@handle`
   - `https://www.youtube.com/channel/UC-XXXXX`
   - `https://www.youtube.com/user/username`
   - `@handle` (bare handle)
   - `UC-XXXXX` (bare channel ID)
2. Click **Analyze** and wait for results
3. View discovered promotions with product names, URLs, mention counts, and video lists
4. Export to CSV or JSON for further analysis

### Domain Search
1. Enter any domain (e.g., `amazon.com`, `nordvpn.com`)
2. View all YouTube videos mentioning that domain

### Other Tools
Each tool has its own dedicated page accessible from the main navigation.

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: HTML5, CSS3 (Tailwind CSS), Vanilla JavaScript
- **API**: YouTube Data API v3
- **Deployment**: Vercel
- **Utilities**: Custom URL parsing and link extraction

## 📁 Project Structure

```
yt-promo-finder/
├── api/
│   ├── analyze.js      # Promotion analysis endpoint
│   ├── domain.js       # Domain search endpoint
│   ├── unlisted.js     # Unlisted video finder endpoint
│   ├── growth.js       # Growth tracker endpoint
│   ├── collab.js       # Collaboration finder endpoint
│   ├── compare.js      # Sponsor comparison endpoint
│   ├── rate.js         # Sponsorship rate estimator endpoint
│   ├── viral.js        # Viral video detector endpoint
│   ├── saturation.js   # Sponsor saturation score endpoint
│   ├── tiktok.js       # TikTok metadata endpoint
│   ├── tiktok-video.js # TikTok video proxy download endpoint
│   ├── tiktok-audio.js # TikTok audio proxy download endpoint
│   └── quota.js        # API quota status endpoint
├── public/
│   ├── index.html      # Main promotion finder UI
│   ├── domain.html     # Domain search UI
│   ├── unlisted.html   # Unlisted videos UI
│   ├── growth.html     # Growth tracker UI
│   ├── collab.html     # Collaboration finder UI
│   ├── compare.html    # Compare sponsors UI
│   ├── rate.html       # Rate estimator UI
│   ├── viral.html      # Viral detector UI
│   ├── saturation.html # Saturation score UI
│   ├── tiktok.html     # TikTok downloader UI
│   ├── privacy.html    # Privacy policy
│   ├── terms.html      # Terms of service
│   └── disclaimer.html # Disclaimer
├── server.js           # Express server (local development)
├── utils.js            # Shared utility functions
├── vercel.json         # Vercel deployment config
├── package.json        # Dependencies
├── DEPLOYMENT.md       # Deployment documentation
└── README.md           # This file
```

## 🌐 Deployment

### Deploy to Vercel (Recommended)

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   vercel --prod
   ```

3. Set environment variables in Vercel dashboard:
   - `YOUTUBE_API_KEY`

### Deploy to Other Platforms

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions for Render, Railway, and other platforms.

## 🔒 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `YOUTUBE_API_KEY` | Your YouTube Data API v3 key | Yes |
| `PORT` | Server port (default: 3000) | No |

## 📝 API Endpoints

### `GET /api/analyze`
Analyzes a YouTube channel for promotions.

**Query Parameters:**
- `url` (required): YouTube channel URL, handle, or channel ID

**Response:**
```json
{
  "channelId": "UC-XXXXX",
  "videoCount": 156,
  "sinceISO": "2025-02-01T00:00:00.000Z",
  "promotions": [
    {
      "url": "https://example.com/product",
      "domain": "example.com",
      "productName": "Cool Product",
      "occurrences": 5,
      "videos": [...]
    }
  ]
}
```

### `GET /api/domain`
Searches for videos mentioning a specific domain.

**Query Parameters:**
- `domain` (required): Domain to search for

### `GET /api/unlisted`
Finds unlisted videos from a channel.

**Query Parameters:**
- `url` (required): YouTube channel URL

### `GET /api/growth`
Analyzes channel growth and upload patterns.

**Query Parameters:**
- `url` (required): YouTube channel URL

### `GET /api/collab`
Finds collaborations and channel mentions.

**Query Parameters:**
- `url` (required): YouTube channel URL

### `GET /api/compare`
Compares sponsors across multiple channels.

**Query Parameters:**
- `urls` (required): Comma-separated YouTube channel URLs

### `GET /api/quota`
Returns current API quota status.

**Response:**
```json
{
  "used": 1500,
  "limit": 10000,
  "remaining": 8500,
  "percentUsed": 15,
  "isLow": false,
  "isExhausted": false
}
```

### `GET /api/tiktok`
Fetches downloadable TikTok metadata from a public TikTok URL.

**Query Parameters:**
- `url` (required): TikTok video URL

### `GET /api/tiktok-video`
Proxies a downloadable TikTok video file.

**Query Parameters:**
- `url` (required): Video URL returned by `/api/tiktok`

### `GET /api/tiktok-audio`
Proxies a downloadable TikTok audio file.

**Query Parameters:**
- `url` (required): Audio URL returned by `/api/tiktok`

## ⚠️ Limitations

- Results are based on video descriptions only
- May not capture promotions shown on-screen or mentioned in audio
- Subject to YouTube API quota limits (10,000 units/day by default)
- Analyzes only the last 12 months of uploads

## 🎯 Use Cases

- **Brands & Marketers**: Find creators promoting competitors, discover influencer partners
- **Content Creators**: Research sponsorship opportunities in your niche
- **Researchers & Journalists**: Investigate sponsorship trends and undisclosed partnerships
- **Curious Viewers**: See how your favorite creators monetize their content

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

## 🙏 Acknowledgments

- Built with [YouTube Data API v3](https://developers.google.com/youtube/v3)
- Styled with [Tailwind CSS](https://tailwindcss.com)
- Icons from [Heroicons](https://heroicons.com)
- Deployed on [Vercel](https://vercel.com)

---

Made with ♥ by [David J Woodbury](https://davidjwoodbury.com)

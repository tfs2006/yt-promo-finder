# 🎯 YouTube Channel Promotion Finder

A beautiful web application that analyzes YouTube channels to discover product promotions and affiliate links from the last year of uploads.

![YouTube Promo Finder](https://img.shields.io/badge/YouTube-API-red?style=for-the-badge&logo=youtube)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)

## ✨ Features

- 🔍 **Channel Analysis** - Analyzes the last 12 months of video uploads
- 🎯 **Smart Detection** - Identifies product links and promotions from video descriptions
- 🎨 **Modern UI** - Beautiful, responsive design with glass morphism effects
- 📋 **Copy to Clipboard** - Easy copying of promotion URLs
- ⚡ **Fast & Cached** - In-memory caching for quick repeated searches
- 📱 **Mobile Friendly** - Fully responsive design

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

1. Enter a YouTube channel URL in any of these formats:
   - `https://www.youtube.com/@handle`
   - `https://www.youtube.com/channel/UC-XXXXX`
   - `https://www.youtube.com/user/username`
   - `@handle` (bare handle)
   - `UC-XXXXX` (bare channel ID)

2. Click **Analyze** and wait for results

3. View discovered promotions with:
   - Product names and URLs
   - Number of mentions
   - List of videos featuring each promotion
   - Quick copy-to-clipboard functionality

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: HTML5, CSS3 (Tailwind CSS), Vanilla JavaScript
- **API**: YouTube Data API v3
- **Deployment Ready**: Works with Vercel, Render, Railway, etc.

## 📁 Project Structure

```
yt-promo-finder/
├── public/
│   └── index.html      # Frontend UI
├── server.js           # Express server & API logic
├── package.json        # Dependencies
├── .env.example        # Environment variables template
└── README.md          # Documentation
```

## 🌐 Deployment

### Deploy to Vercel

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   vercel
   ```

3. Set environment variables in Vercel dashboard:
   - `YOUTUBE_API_KEY`

### Deploy to Render

1. Create a new Web Service on [Render](https://render.com)
2. Connect your GitHub repository
3. Set environment variables
4. Deploy!

### Deploy to Railway

1. Create a new project on [Railway](https://railway.app)
2. Connect your GitHub repository
3. Add environment variables
4. Deploy automatically

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

**Example:**
```
GET /api/analyze?url=https://www.youtube.com/@PhilipDeFranco
```

**Response:**
```json
{
  "videoCount": 156,
  "sinceISO": "2024-11-01T00:00:00.000Z",
  "promotions": [
    {
      "url": "https://example.com/product",
      "domain": "example.com",
      "productName": "Cool Product",
      "occurrences": 5,
      "videos": [
        {
          "videoId": "abc123",
          "title": "Video Title",
          "publishedAt": "2024-10-15T12:00:00Z"
        }
      ]
    }
  ]
}
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

## ⚠️ Limitations

- Results are based on video descriptions only
- May not capture promotions shown on-screen or mentioned in audio
- Subject to YouTube API quota limits (10,000 units/day by default)

## 🙏 Acknowledgments

- Built with [YouTube Data API v3](https://developers.google.com/youtube/v3)
- Styled with [Tailwind CSS](https://tailwindcss.com)
- Icons from [Heroicons](https://heroicons.com)

---

Made with ♥ by [Your Name]

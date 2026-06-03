# Creator Video Comparator — RAG + Gemini

Compare YouTube vs Instagram Reel metrics with a full-stack LangChain RAG pipeline powered by **Gemini**.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 + React 19 |
| Backend API | Next.js Route Handlers (App Router) |
| Orchestration | **LangChain** (`@langchain/core`, `@langchain/classic`) |
| Embeddings | Local hash embeddings (zero-setup) or OpenAI `text-embedding-3-small` |
| Vector DB | LangChain `MemoryVectorStore` (in-process) |
| LLM | **Gemini 1.5 Flash** via Google Generative Language API |
| Transcript | `youtube-transcript` library + yt-dlp fallback + page-scrape fallback |

## What Gets Extracted

| Field | YouTube | Instagram |
|---|---|---|
| Title | ✅ | ✅ |
| Creator name | ✅ | ✅ |
| Views | ✅ (page scrape) | ⚠️ API required |
| Likes | ⚠️ YouTube API key needed | ⚠️ API required |
| Comments | ⚠️ YouTube API key needed | ⚠️ API required |
| Followers | ⚠️ yt-dlp needed | ⚠️ Creator API needed |
| Duration | ✅ | ⚠️ yt-dlp needed |
| Upload date | ✅ | ⚠️ yt-dlp needed |
| Hashtags | ✅ from description | ✅ from caption |
| Thumbnail | ✅ | ✅ |
| Transcript | ✅ (youtube-transcript-api) | ⚠️ caption fallback |

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` and set your Gemini API key:

```
GOOGLE_API_KEY=AIza...your_key_here
GEMINI_MODEL=gemini-1.5-flash
```

Get a free Gemini API key at: https://aistudio.google.com/app/apikey

### 3. (Optional but recommended) Install yt-dlp for richer metadata

```bash
# macOS
brew install yt-dlp

# Windows — download yt-dlp.exe to bin/yt-dlp.exe in this project
# https://github.com/yt-dlp/yt-dlp/releases

# Linux
pip install yt-dlp
```

With yt-dlp, you get: likes, duration, upload date, follower count, and better transcripts.

### 4. Run the dev server

```bash
npm run dev
```

Open http://localhost:3000

## Usage

1. Paste a YouTube video URL into the **YouTube URL** field
2. Paste an Instagram Reel URL into the **Instagram Reel URL** field
3. Click **Analyze** — extraction, chunking, and vector indexing happen automatically
4. Use the starter questions or type your own to chat with Gemini about both videos

## Why Metrics Show "API Required"

Both YouTube and Instagram restrict metrics (likes, comments, followers, views) from unauthenticated
scraping. To unlock them:

- **YouTube**: Use the YouTube Data API v3 (free quota) — set `YOUTUBE_API_KEY` (not yet wired in, requires extending `extractors.ts`)  
- **Instagram**: Instagram Graph API requires a business account token
- **yt-dlp**: Gets the most metadata without API keys for YouTube; install it for best results

## Architecture

```
Browser → POST /api/analyze
  → extractors.ts (youtube-transcript + yt-dlp + page scrape)
  → rag.ts → RecursiveCharacterTextSplitter → MemoryVectorStore
  → session saved in memory

Browser → POST /api/chat (streaming)
  → session.vectorStore.similaritySearch(question, 6)
  → Gemini 1.5 Flash (with full metrics + retrieved chunks in prompt)
  → streamed text/plain response
```

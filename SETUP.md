# Pinned — Setup Guide

This guide covers every account you need to create and every key you need to plug in before the app works. Do these in order.

---

## Accounts to create

### 1. Supabase (database + auth) — Free
1. Go to https://supabase.com → Sign up → New project
2. Name it `pinned`, pick a region close to you (US East for NYC-heavy users)
3. Save your **database password** somewhere safe
4. Once the project is ready, go to **Settings → API**
5. Copy:
   - `Project URL` → `SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (backend only — never put this in the app)
6. Go to **SQL Editor** → paste and run everything in `/supabase/schema.sql`
7. Go to **Authentication → Providers** → enable **Email** (magic link, no password)

### 2. OpenAI (transcription) — Pay per use (~$0.006/minute of audio)
1. Go to https://platform.openai.com → Sign up → API Keys
2. Create a new key → copy to `OPENAI_API_KEY`
3. Add a payment method. At your usage level, expect $10-30/month.

### 3. Anthropic (place extraction AI) — Pay per use (~$0.003 per video)
1. Go to https://console.anthropic.com → Sign up → API Keys
2. Create a key → copy to `ANTHROPIC_API_KEY`
3. Add a payment method.

### 4. Google Cloud (geocoding + maps) — Pay per use (~$0.017/place lookup)
1. Go to https://console.cloud.google.com → Create project named `pinned`
2. Go to **APIs & Services → Library**, enable:
   - **Places API (New)**
   - **Maps JavaScript API** (for future web use)
3. Go to **APIs & Services → Credentials → Create Credentials → API Key**
4. Copy to `GOOGLE_PLACES_API_KEY`
5. Restrict the key to the two APIs above

### 5. Apple Developer Program ($99/year) — Required for share extension + App Store
1. Go to https://developer.apple.com/programs/enroll/
2. Enroll as an individual
3. Once approved, go to **Certificates, Identifiers & Profiles → Identifiers**
4. Create an App ID: `com.pinned.app`
5. Enable capability: **App Groups**
6. Create App Group: `group.com.pinned.app`

### 6. Expo EAS ($29/month) — Required for building the iOS app
1. Go to https://expo.dev → Sign up → new organization
2. Install EAS CLI: `npm install -g eas-cli`
3. In the `mobile/` directory: `eas login` → `eas build:configure`
4. This creates `eas.json` and populates `extra.eas.projectId` in `app.json`

### 7. Railway (backend hosting) — ~$5/month
1. Go to https://railway.app → Sign up with GitHub
2. New project → Deploy from GitHub repo → select this repo → set root to `backend/`
3. Add environment variables (all keys from `backend/.env.example`)
4. Install yt-dlp on the Railway instance by adding to your Dockerfile (see below)
5. Copy your Railway deployment URL → set as `EXPO_PUBLIC_API_URL` in the mobile `.env`

---

## Local development setup

### Mobile app
```bash
cd mobile
cp .env.example .env
# Fill in all values
npm install
npx expo start --ios
```

### Backend
```bash
cd backend
cp .env.example .env
# Fill in all values

# Install yt-dlp (required for video audio extraction)
# macOS:
brew install yt-dlp
# Linux (Railway):
pip install yt-dlp

npm install
npm run dev
```

Test the pipeline:
```bash
curl -X POST http://localhost:3000/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SUPABASE_JWT" \
  -d '{"url": "https://www.youtube.com/watch?v=SOME_FOOD_VIDEO"}'
```

---

## Building for iPhone (TestFlight)

Once all accounts are set up and keys are filled in:

```bash
cd mobile

# Build for iOS simulator first (no Apple Developer account needed)
npx expo run:ios

# Build for a real device / TestFlight (requires Apple Developer + EAS)
eas build --platform ios --profile preview
```

The `preview` profile generates an `.ipa` you can install on your own device via TestFlight without a full App Store review.

---

## File structure

```
App/
├── mobile/          # React Native (Expo) iOS app
│   ├── app/         # Screens (expo-router)
│   │   ├── sign-in.tsx
│   │   ├── (tabs)/
│   │   │   ├── index.tsx   # Map view
│   │   │   └── list.tsx    # List / feed view
│   │   └── place/[id].tsx  # Place detail modal
│   ├── components/  # PlaceCard, ProcessingBanner
│   ├── lib/         # Supabase client, API calls, hooks, types
│   └── constants/   # Colors, shadows, border radius
├── backend/         # Node.js video processing API
│   └── src/
│       ├── index.ts           # Express server
│       ├── middleware/auth.ts  # JWT verification
│       ├── routes/places.ts   # POST /process
│       └── services/
│           ├── extractor.ts   # yt-dlp audio download + oEmbed thumbnails
│           ├── transcribe.ts  # OpenAI Whisper
│           ├── placeParser.ts # Claude extracts place from transcript
│           └── geocoder.ts    # Google Places geocoding
└── supabase/
    └── schema.sql   # Run this in Supabase SQL editor
```

---

## How a save works end-to-end

1. User taps Share on TikTok → selects Pinned
2. iOS Share Extension captures the URL → saves to App Group storage → shows "Saving…"
3. When main app opens, it reads the pending URL → sends to backend `POST /process`
4. Backend creates a `processing_jobs` row → responds immediately with `jobId`
5. Background pipeline runs:
   - `yt-dlp` downloads audio-only to `/tmp`
   - OpenAI Whisper transcribes the speech
   - Claude identifies the place name, city, category, and description
   - Google Places finds exact coordinates and address
   - Place saved to Supabase `places` table
   - Temp audio file deleted
6. Supabase real-time subscription fires → pin appears on map in the app

Typical end-to-end time: **8-15 seconds**

---

## Cost at 1,000 saves/month

| Service | Cost |
|---|---|
| Supabase (Pro) | $25 |
| OpenAI Whisper (avg 3min video) | ~$18 |
| Anthropic Claude | ~$3 |
| Google Places | ~$17 |
| Railway | ~$10 |
| Expo EAS | $29 |
| Apple Developer | $8 (amortized) |
| **Total** | **~$110/month** |

At 10,000 saves/month (startup scale): ~$300/month. Well within your budget.

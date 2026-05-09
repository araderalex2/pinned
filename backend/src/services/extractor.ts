import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'

const execFileAsync = promisify(execFile)

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'unknown'

export interface ExtractedMedia {
  audioPath: string
  thumbnailUrl: string | null
  title: string | null
  description: string | null
  locationTag: string | null
  platform: Platform
  cleanup: () => void
}

export function detectPlatform(url: string): Platform {
  if (/tiktok\.com/i.test(url)) return 'tiktok'
  if (/instagram\.com/i.test(url)) return 'instagram'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook'
  return 'unknown'
}

// Fetch thumbnail via official oEmbed endpoints where available — no video download needed
export async function fetchOEmbed(url: string, platform: Platform): Promise<{ thumbnail: string | null; title: string | null }> {
  try {
    let oembedUrl: string | null = null

    if (platform === 'tiktok') {
      oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
    } else if (platform === 'youtube') {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    }
    // Instagram deprecated oembed for Reels; Facebook requires app token — skip both

    if (!oembedUrl) return { thumbnail: null, title: null }

    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { thumbnail: null, title: null }

    const data = await res.json() as { thumbnail_url?: string; title?: string }
    return {
      thumbnail: data.thumbnail_url ?? null,
      title: data.title ?? null,
    }
  } catch {
    return { thumbnail: null, title: null }
  }
}

// Download audio-only track to a temp file using yt-dlp
// Deletes the file when cleanup() is called
export async function downloadAudio(url: string): Promise<ExtractedMedia & { platform: Platform }> {
  const platform = detectPlatform(url)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-'))
  const audioPath = path.join(tmpDir, 'audio.mp3')

  const ytDlpArgs = [
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '5',        // lowest quality sufficient for speech recognition
    '--no-playlist',
    '--no-write-info-json',
    '--no-write-thumbnail',
    '--quiet',
    '--output', audioPath,
    url,
  ]

  try {
    // Resolve yt-dlp from Homebrew path if not on PATH
    const ytDlpBin = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'].find(p => {
      try { require('fs').accessSync(p); return true } catch { return false }
    }) ?? 'yt-dlp'
    await execFileAsync(ytDlpBin, ytDlpArgs, { timeout: 60_000 })
  } catch (err: any) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    // TikTok photo slideshows redirect to a /photo/ URL that yt-dlp can't process
    if (err.message?.includes('/photo/')) {
      throw Object.assign(new Error('PHOTO_SLIDESHOW'), { isSlideshow: true, originalUrl: url })
    }
    throw new Error(`Audio download failed: ${err.message}`)
  }

  if (!fs.existsSync(audioPath)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw new Error('yt-dlp completed but audio file not found')
  }

  const [oembed, description, locationTag] = await Promise.all([
    fetchOEmbed(url, platform),
    fetchDescription(url),
    fetchLocationTag(url),
  ])

  return {
    audioPath,
    thumbnailUrl: oembed.thumbnail,
    title: oembed.title,
    description,
    locationTag,
    platform,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  }
}

// Fetch the full post caption/description using yt-dlp (fast, skip-download)
export async function fetchDescription(url: string): Promise<string | null> {
  try {
    const ytDlpBin = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'].find(p => {
      try { require('fs').accessSync(p); return true } catch { return false }
    }) ?? 'yt-dlp'

    const { stdout } = await execFileAsync(ytDlpBin, [
      '--print', 'description',
      '--skip-download',
      '--no-playlist',
      '--quiet',
      url,
    ], { timeout: 15000 })

    const desc = stdout.trim()
    return desc && desc.length > 5 ? desc : null
  } catch {
    return null
  }
}

// Fetch the TikTok/Instagram location tag (e.g. "Now Now NoHo · New York")
// Tries yt-dlp first; falls back to scraping TikTok's page HTML directly
export async function fetchLocationTag(url: string): Promise<string | null> {
  // Attempt 1: yt-dlp --dump-json
  try {
    const ytDlpBin = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'].find(p => {
      try { require('fs').accessSync(p); return true } catch { return false }
    }) ?? 'yt-dlp'

    const { stdout } = await execFileAsync(ytDlpBin, [
      '--dump-json',
      '--skip-download',
      '--no-playlist',
      '--quiet',
      url,
    ], { timeout: 20000 })

    const info = JSON.parse(stdout.trim())

    // Log all top-level fields so we can spot where TikTok stores the POI tag
    const allFields = Object.entries(info)
      .filter(([, v]) => v !== null && v !== undefined && v !== 'NA' && v !== '')
      .filter(([, v]) => typeof v !== 'object' || (typeof v === 'object' && Object.keys(v as object).length > 0))
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v).slice(0, 120)
        return `${k}=${val}`
      })
    console.log('[ytdlp-fields]', allFields.join(' | '))

    const candidates: (string | undefined | null)[] = [
      info.location,
      info.poi_name,
      info.poi_info?.poi_name,
      info.poi_info?.name,
      info.poi_info?.address,
      info.author?.poi_name,
      info.uploader_poi,
    ]

    for (const c of candidates) {
      if (c && typeof c === 'string' && c !== 'NA' && c.trim().length > 1) {
        return c.trim()
      }
    }
  } catch (err: any) {
    console.warn('[location-ytdlp-error]', err.message?.slice(0, 200) ?? err)
  }

  // Attempt 2: scrape the TikTok page HTML for embedded POI JSON
  if (/tiktok\.com/i.test(url)) {
    try {
      const scraped = await scrapeTikTokPoi(url)
      if (scraped) {
        console.log(`[tiktok-scrape] found POI: "${scraped}"`)
        return scraped
      }
    } catch (err: any) {
      console.warn('[location-scrape-error]', err.message?.slice(0, 200) ?? err)
    }
  }

  return null
}

// Scrape TikTok page HTML for embedded video metadata JSON
async function scrapeTikTokPoi(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    console.warn(`[tiktok-scrape] HTTP ${res.status}`)
    return null
  }

  const html = await res.text()

  // TikTok embeds video metadata in this script tag
  const match = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) {
    console.warn('[tiktok-scrape] rehydration script tag not found')
    return null
  }

  let data: any
  try {
    data = JSON.parse(match[1])
  } catch {
    console.warn('[tiktok-scrape] could not parse embedded JSON')
    return null
  }

  // Walk common paths where TikTok stores POI info
  const itemStruct = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct
  const poi = itemStruct?.poi || itemStruct?.anchors?.find((a: any) => a?.type === 30 || a?.thumbnail) // type 30 = POI
  const anchorPoi = itemStruct?.anchors?.[0]

  // Try several places
  const tries = [
    poi?.name,
    poi?.poi_name,
    poi?.poi_info?.poi_name,
    anchorPoi?.name,
    anchorPoi?.description,
    itemStruct?.locationCreated,
  ].filter(Boolean) as string[]

  for (const t of tries) {
    if (typeof t === 'string' && t.trim().length > 1) {
      // Add city if available
      const city = itemStruct?.poi?.city_name || itemStruct?.poi?.address || ''
      return city ? `${t.trim()} · ${city}` : t.trim()
    }
  }

  // Last resort: dump a small slice of the JSON keys for debugging
  if (itemStruct) {
    const keys = Object.keys(itemStruct).slice(0, 30).join(',')
    console.log('[tiktok-scrape] itemStruct keys:', keys)
    if (itemStruct.poi) console.log('[tiktok-scrape] poi:', JSON.stringify(itemStruct.poi).slice(0, 300))
    if (itemStruct.anchors) console.log('[tiktok-scrape] anchors:', JSON.stringify(itemStruct.anchors).slice(0, 500))
  }

  return null
}

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
// yt-dlp exposes this as the `location` field in its info dict
export async function fetchLocationTag(url: string): Promise<string | null> {
  try {
    const ytDlpBin = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'].find(p => {
      try { require('fs').accessSync(p); return true } catch { return false }
    }) ?? 'yt-dlp'

    const { stdout } = await execFileAsync(ytDlpBin, [
      '--print', 'location',
      '--skip-download',
      '--no-playlist',
      '--quiet',
      url,
    ], { timeout: 15000 })

    const loc = stdout.trim()
    // yt-dlp prints "NA" when the field is missing
    return loc && loc !== 'NA' && loc.length > 1 ? loc : null
  } catch {
    return null
  }
}

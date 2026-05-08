import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import OpenAI from 'openai'

const execFileAsync = promisify(execFile)

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, timeout: 60000, maxRetries: 2 })
  return _openai
}

// Try to get subtitles from the video URL using yt-dlp (fast, no API needed)
export async function extractSubtitles(url: string): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-subs-'))
  const outTemplate = path.join(tmpDir, 'subs')
  try {
    await execFileAsync('yt-dlp', [
      '--write-subs', '--write-auto-subs',
      '--sub-lang', 'en',
      '--skip-download',
      '--output', outTemplate,
      url,
    ], { timeout: 30000 })

    // Find any subtitle file
    const files = fs.readdirSync(tmpDir)
    const subFile = files.find(f => f.endsWith('.vtt') || f.endsWith('.srt'))
    if (!subFile) return null

    const raw = fs.readFileSync(path.join(tmpDir, subFile), 'utf-8')
    // Strip VTT/SRT formatting, keep just text
    const text = raw
      .replace(/WEBVTT.*?\n\n/s, '')
      .replace(/^\d+\n/gm, '')
      .replace(/\d{2}:\d{2}[:\d,.]+ --> .+/g, '')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    return text.length > 20 ? text : null
  } catch {
    return null
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

export async function transcribeAudio(audioPath: string): Promise<string> {
  const stat = fs.statSync(audioPath)
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error('Audio file too large for transcription (>25MB)')
  }

  const response = await getOpenAI().audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'text',
  })

  return response as unknown as string
}

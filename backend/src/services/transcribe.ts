import fs from 'fs'
import OpenAI from 'openai'

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
  return _openai
}

export async function transcribeAudio(audioPath: string): Promise<string> {
  const stat = fs.statSync(audioPath)

  // Whisper API limit is 25MB. Most social videos are well under this.
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

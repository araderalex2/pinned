import Anthropic from '@anthropic-ai/sdk'

let _anthropic: Anthropic | null = null
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return _anthropic
}

export interface ParsedPlace {
  name: string
  city: string
  country: string
  neighborhood?: string
  category: 'restaurant' | 'cafe' | 'bar' | 'club' | 'shop' | 'museum' | 'gallery' | 'hotel' | 'other'
  description: string
  highlights: string[]
  confidence: number
}

const SYSTEM_PROMPT = `You are an assistant that extracts place information from social media content.

Given text from a TikTok, Instagram, or YouTube post — this may be an audio transcript, OCR text from a photo slideshow, or a mix — extract ALL places being featured.
Return ONLY a JSON array — no markdown, no explanation.

Rules:
- Extract every distinct place mentioned (single video = 1 place, listicle = multiple)
- description: one sentence summary of what makes this place worth visiting
- highlights: exactly 3 short bullet points (each under 12 words) describing the PLACE itself — what it sells or offers, the vibe/atmosphere, and a practical detail like location or who it's for. Never describe a specific product, dish, or item shown in the video.
- category must be one of: restaurant, cafe, bar, club, shop, museum, gallery, hotel, other
- neighborhood: street, neighborhood, or district mentioned for this place (e.g. "Washington St West Village", "Grand St SoHo") — include if mentioned, omit if not
- confidence is 0-1. Use < 0.6 when a place is ambiguous or not clearly named
- Omit any place with confidence < 0.6
- If no places are mentioned, return []

JSON format:
[
  {
    "name": "Place Name",
    "city": "City",
    "country": "Country",
    "neighborhood": "West Village",
    "category": "restaurant",
    "description": "One sentence summary.",
    "highlights": ["What the place sells or specializes in", "The vibe or atmosphere", "Who it's for or where it's located"],
    "confidence": 0.95
  }
]`

export async function parsePlaces(
  transcript: string,
  videoTitle: string | null,
  postCaption?: string | null
): Promise<ParsedPlace[]> {
  const userContent = [
    videoTitle ? `Video title: "${videoTitle}"` : null,
    postCaption ? `Post caption:\n${postCaption}` : null,
    transcript ? `Transcript:\n${transcript.slice(0, 6000)}` : null,
  ].filter(Boolean).join('\n\n')

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p: any) => p.confidence >= 0.5 && p.name && p.city)
      .map((p: any) => ({
        ...p,
        highlights: Array.isArray(p.highlights) ? p.highlights : [],
      })) as ParsedPlace[]
  } catch {
    return []
  }
}

// Convenience wrapper for single-place use (test pipeline)
export async function parsePlace(
  transcript: string,
  videoTitle: string | null
): Promise<ParsedPlace | null> {
  const places = await parsePlaces(transcript, videoTitle)
  return places[0] ?? null
}

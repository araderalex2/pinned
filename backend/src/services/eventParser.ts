import Anthropic from '@anthropic-ai/sdk'

let _anthropic: Anthropic | null = null
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return _anthropic
}

export interface ParsedEvent {
  event_name: string
  performer: string | null
  venue_name: string
  city: string
  country: string
  event_date: string | null
  event_time: string | null
  description: string
  confidence: number
}

const SYSTEM_PROMPT = `You are an assistant that extracts event information from social media content.

Given text from a TikTok, Instagram, or YouTube post, extract ALL events being featured.
An event is something happening at a specific venue on a specific date — concert, live show, performance, pop-up, market, party, art opening, comedy night, etc.
Return ONLY a JSON array — no markdown, no explanation.

Rules:
- Only extract events with a clear venue AND date. If either is missing, skip it.
- event_name: name of the event or show (e.g. "Max & Luke Dean Live", "Saturday Night Pop-Up")
- performer: who is performing or hosting — null if not a performance
- venue_name: the venue name (e.g. "Brooklyn Storehouse", "Madison Square Garden")
- city + country: location of the venue
- event_date: the date as a string (e.g. "May 15, 2026"). If only month/day given, assume year 2026.
- event_time: time if explicitly mentioned (e.g. "8:00 PM"), null if not mentioned
- description: one sentence about the event
- confidence: 0-1. Use < 0.7 if venue or date is unclear
- Omit any event with confidence < 0.7
- If no qualifying events found, return []

JSON format:
[
  {
    "event_name": "Max & Luke Dean Live",
    "performer": "Max & Luke Dean",
    "venue_name": "Brooklyn Storehouse",
    "city": "Brooklyn",
    "country": "United States",
    "event_date": "May 15, 2026",
    "event_time": "8:00 PM",
    "description": "An intimate live performance from rising artists Max and Luke Dean.",
    "confidence": 0.92
  }
]`

export async function parseEvents(
  transcript: string,
  videoTitle: string | null,
  postCaption?: string | null
): Promise<ParsedEvent[]> {
  const userContent = [
    videoTitle ? `Video title: "${videoTitle}"` : null,
    postCaption ? `Post caption:\n${postCaption}` : null,
    transcript ? `Transcript:\n${transcript.slice(0, 6000)}` : null,
  ].filter(Boolean).join('\n\n')

  const message = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e: any) => e.confidence >= 0.7 && e.event_name && e.venue_name) as ParsedEvent[]
  } catch {
    return []
  }
}

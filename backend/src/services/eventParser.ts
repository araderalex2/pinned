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
  event_category: 'concert' | 'sports' | 'theater' | 'comedy' | 'club' | 'festival' | 'art' | 'popup' | 'other'
  confidence: number
}

const SYSTEM_PROMPT = `You are an assistant that extracts event information from social media content, including event flyers posted as TikTok or Instagram photo slideshows.

Given text from a post — which may be a transcript, OCR text from slides, or a post caption — extract ALL events.
An event is something happening at a specific venue on a specific date: concert, DJ set, live show, performance, pop-up, market, party, rave, club night, art opening, comedy night, etc.
Return ONLY a JSON array — no markdown, no explanation.

Rules:
- Extract events where both a venue AND a date can be identified.
- event_name: the name of the event or show. For DJ sets use the performer format (e.g. "Max Dean b2b Luke Dean"). If no specific event name, use "Live at [venue]".
- performer: who is performing or headlining. For b2b sets include both names (e.g. "Max Dean b2b Luke Dean"). null if not a performance.
- venue_name: the venue (e.g. "Brooklyn Storehouse", "Madison Square Garden")
- city + country: infer from context or known venue location
- event_date: the date as a readable string. Handle ALL of these formats:
  - "July_24" or "July_24_2026" → "July 24, 2026"
  - "July 24" → "July 24, 2026"
  - "7/24" or "7-24" → "July 24, 2026"
  - If only month/day given, assume year 2026
- event_time: time if mentioned (e.g. "10:00 PM"), null if not
- description: one sentence about the event
- event_category: one of: concert, sports, theater, comedy, club, festival, art, popup, other
  - concert: live music, bands, solo artists performing
  - sports: games, matches, tournaments, races
  - theater: broadway, plays, musicals, opera, dance
  - comedy: stand-up, improv, comedy shows
  - club: DJ sets, raves, club nights, b2b sets, techno/house parties
  - festival: multi-day events, outdoor festivals, music festivals, markets
  - art: gallery openings, exhibitions, art shows
  - popup: pop-up shops, pop-up restaurants, brand activations
  - other: anything else
- confidence: 0-1. Use 0.85+ when venue and date are both clearly stated. Use < 0.65 only if both are truly ambiguous.
- Omit events with confidence < 0.65
- If no qualifying events found, return []

Common patterns to recognize:
- Event flyer text: "[Date] / [Venue] / [Performer]" or "[Venue] / [Date]" stacked on a graphic
- "b2b" = back-to-back DJ set between two performers (e.g. "Max Dean b2b Luke Dean")
- "ALL NIGHT LONG" = all-night DJ/club event
- Presale or ticket info confirms it's a real upcoming event
- "@Brooklyn Storehouse" or "@VenueName" in a caption = the venue

JSON format:
[
  {
    "event_name": "Max Dean b2b Luke Dean",
    "performer": "Max Dean b2b Luke Dean",
    "venue_name": "Brooklyn Storehouse",
    "city": "Brooklyn",
    "country": "United States",
    "event_date": "July 24, 2026",
    "event_time": null,
    "event_category": "club",
    "description": "All-night b2b DJ set from UK house music artists Max Dean and Luke Dean at Brooklyn Storehouse.",
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
    return parsed.filter((e: any) => e.confidence >= 0.65 && e.event_name && e.venue_name) as ParsedEvent[]
  } catch {
    return []
  }
}

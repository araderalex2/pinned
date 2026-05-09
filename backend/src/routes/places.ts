import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { downloadAudio, fetchDescription } from '../services/extractor'
import { transcribeAudio, extractSubtitles } from '../services/transcribe'
import { parsePlaces } from '../services/placeParser'
import { parseEvents } from '../services/eventParser'
import { geocodePlace } from '../services/geocoder'
import { extractSlideshow } from '../services/slideshowExtractor'

const router = Router()

// Supabase admin client (service role key — bypasses RLS for backend writes)
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// POST /process
// Body: { url: string }
// Header: Authorization: Bearer <supabase_jwt>
router.post('/process', async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string }

  if (!url || typeof url !== 'string') {
    res.status(400).json({ message: 'url is required' })
    return
  }

  // Validate it's a supported platform URL
  const supportedDomains = ['tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch']
  const isSupported = supportedDomains.some(d => url.includes(d))
  if (!isSupported) {
    res.status(400).json({ message: 'Unsupported platform. Share a TikTok, Instagram, YouTube, or Facebook video.' })
    return
  }

  const userId = (req as any).userId as string
  const supabase = getSupabase()

  // Create a job record immediately so the app can show "processing" state
  const { data: job, error: jobError } = await supabase
    .from('processing_jobs')
    .insert({ user_id: userId, url, status: 'pending' })
    .select()
    .single()

  if (jobError || !job) {
    res.status(500).json({ message: 'Failed to create job' })
    return
  }

  // Respond immediately — processing happens async
  res.json({ jobId: job.id })

  // Process in background (no await — fire and forget)
  processVideo(job.id, userId, url, supabase).catch(err => {
    console.error(`Job ${job.id} failed:`, err)
  })
})

async function processVideo(jobId: string, userId: string, url: string, supabase: any) {
  const update = (status: string, extra?: object) =>
    supabase.from('processing_jobs').update({ status, ...extra }).eq('id', jobId)

  await update('processing')

  let media: Awaited<ReturnType<typeof downloadAudio>> | null = null

  try {
    // Step 1: Download audio + get thumbnail (falls back to Playwright for photo slideshows)
    let transcript = ''
    let title: string | null = null
    let description: string | null = null
    let thumbnailUrl: string | null = null

    try {
      media = await downloadAudio(url)
      thumbnailUrl = media.thumbnailUrl
      title = media.title
      description = media.description
      if (description) console.log(`Job ${jobId}: caption extracted (${description.length} chars)`)

      // Step 2: Try subtitles first (fast, no API), then Whisper
      try {
        const subs = await extractSubtitles(url)
        if (subs) {
          transcript = subs
          console.log(`Job ${jobId}: subtitles extracted (${subs.length} chars)`)
        } else {
          transcript = await transcribeAudio(media.audioPath)
          console.log(`Job ${jobId}: transcribed via Whisper (${transcript.length} chars)`)
        }
      } catch (err: any) {
        console.warn(`Transcription failed for job ${jobId}: ${err.message} — using title only`)
      }
    } catch (err: any) {
      if (err.isSlideshow) {
        console.log(`Job ${jobId}: photo slideshow detected — using Playwright vision fallback`)
        const [slideshow, slideshowDesc] = await Promise.all([
          extractSlideshow(url),
          fetchDescription(url).catch(() => null),
        ])
        transcript = slideshow.transcript
        title = slideshow.title
        thumbnailUrl = slideshow.thumbnailUrl
        description = slideshowDesc
      } else {
        throw err
      }
    }

    console.log(`Job ${jobId}: transcript=${transcript.length} chars, title=${title}, description=${description?.length ?? 0} chars`)

    // Step 3: Parse places AND events from transcript + title + caption (in parallel)
    const [parsedPlaces, parsedEvents] = await Promise.all([
      parsePlaces(transcript, title, description),
      parseEvents(transcript, title, description).catch((e) => {
        console.warn(`Job ${jobId}: event parsing error: ${e.message}`)
        return []
      }),
    ])

    console.log(`Job ${jobId}: found ${parsedPlaces.length} place(s), ${parsedEvents.length} event(s)`)

    if (!parsedPlaces.length && !parsedEvents.length) {
      throw new Error('Could not identify any places or events in this video')
    }

    // Step 4 & 5: Geocode each place and save
    let savedPlaces = 0
    let lastPlaceId: string | null = null

    for (const parsed of parsedPlaces) {
      const geo = await geocodePlace(parsed)
      if (!geo) {
        console.warn(`Could not geocode "${parsed.name}" — skipping`)
        continue
      }

      const { data: place, error: placeError } = await supabase
        .from('places')
        .insert({
          user_id: userId,
          name: geo.name,
          description: parsed.description,
          highlights: parsed.highlights,
          category: parsed.category,
          address: geo.address,
          city: geo.city,
          country: geo.country,
          lat: geo.lat,
          lng: geo.lng,
          thumbnail_url: thumbnailUrl,
          photo_urls: geo.photoUrls,
          opening_hours: geo.openingHours,
          phone_number: geo.phoneNumber,
          source_url: url,
          google_place_id: geo.googlePlaceId,
        })
        .select()
        .single()

      if (placeError || !place) {
        console.warn(`Failed to save "${parsed.name}":`, placeError?.message)
        continue
      }

      savedPlaces++
      lastPlaceId = place.id
    }

    // Step 6: Geocode each event venue and save
    let savedEvents = 0
    for (const event of parsedEvents) {
      try {
        const geo = await geocodePlace({
          name: event.venue_name,
          city: event.city,
          country: event.country,
          category: 'other',
          description: '',
          highlights: [],
          confidence: 1,
        }).catch(() => null)

        await supabase.from('events').insert({
          user_id: userId,
          event_name: event.event_name,
          performer: event.performer ?? null,
          venue_name: geo?.name ?? event.venue_name,
          description: event.description,
          city: geo?.city ?? event.city,
          country: geo?.country ?? event.country,
          address: geo?.address ?? null,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          event_date: event.event_date,
          event_time: event.event_time,
          event_category: event.event_category ?? 'other',
          source_url: url,
          photo_urls: geo?.photoUrls ?? [],
          google_place_id: geo?.googlePlaceId ?? null,
        })

        savedEvents++
        console.log(`Job ${jobId}: saved event "${event.event_name}" at ${event.venue_name} on ${event.event_date}`)
      } catch (err: any) {
        console.error(`Job ${jobId}: failed to save event "${event.event_name}":`, err.message)
      }
    }

    if (savedPlaces === 0 && savedEvents === 0) {
      throw new Error('Could not save any places or events from this video')
    }

    await update('done', { place_id: lastPlaceId })

  } catch (err: any) {
    console.error(`Job ${jobId} failed:`, err.message)
    await update('failed', { error: err.message ?? 'Unknown error' })
  } finally {
    media?.cleanup()
  }
}

export default router

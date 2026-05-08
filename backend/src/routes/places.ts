import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { downloadAudio } from '../services/extractor'
import { transcribeAudio } from '../services/transcribe'
import { parsePlaces } from '../services/placeParser'
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
    let thumbnailUrl: string | null = null

    try {
      media = await downloadAudio(url)
      thumbnailUrl = media.thumbnailUrl
      title = media.title

      // Step 2: Transcribe (best-effort)
      try {
        transcript = await transcribeAudio(media.audioPath)
      } catch (err: any) {
        console.warn(`Transcription failed for job ${jobId}: ${err.message} — using title only`)
      }
    } catch (err: any) {
      if (err.isSlideshow) {
        console.log(`Job ${jobId}: photo slideshow detected — using Playwright vision fallback`)
        const slideshow = await extractSlideshow(url)
        transcript = slideshow.transcript
        title = slideshow.title
        thumbnailUrl = slideshow.thumbnailUrl
      } else {
        throw err
      }
    }

    // Step 3: Parse all places from transcript + title
    const parsedPlaces = await parsePlaces(transcript, title)
    if (!parsedPlaces.length) throw new Error('Could not identify any places in this video')

    // Step 4 & 5: Geocode each place and save
    let savedCount = 0
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

      savedCount++
      lastPlaceId = place.id
    }

    if (savedCount === 0) throw new Error('Could not save any places from this video')

    await update('done', { place_id: lastPlaceId })

  } catch (err: any) {
    await update('failed', { error: err.message ?? 'Unknown error' })
  } finally {
    media?.cleanup()
  }
}

export default router

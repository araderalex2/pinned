import dotenv from 'dotenv'
dotenv.config({ override: true })
import { createClient } from '@supabase/supabase-js'
import { downloadAudio } from './src/services/extractor'
import { transcribeAudio } from './src/services/transcribe'
import { parsePlaces } from './src/services/placeParser'
import { geocodePlace } from './src/services/geocoder'
import { extractSlideshow } from './src/services/slideshowExtractor'

const TARGET_USER_ID = '0d085080-34d2-4f3b-8d88-87662e6fd61e' // araderalex3@gmail.com
const URLS = [
  'https://www.tiktok.com/t/ZP8gKn36x/',
  'https://www.tiktok.com/t/ZP8gKSmUa/',
  'https://www.tiktok.com/t/ZP8gEmVrX/',
]

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function processUrl(url: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Processing: ${url}`)
  console.log('='.repeat(60))

  let transcript = ''
  let title: string | null = null
  let thumbnailUrl: string | null = null
  let cleanup: (() => void) | null = null

  try {
    console.log('1. Downloading...')
    const media = await downloadAudio(url)
    thumbnailUrl = media.thumbnailUrl
    title = media.title
    cleanup = media.cleanup
    console.log(`   Title: ${title}`)

    console.log('2. Transcribing...')
    try {
      transcript = await transcribeAudio(media.audioPath)
      console.log(`   "${transcript.slice(0, 150)}..."`)
    } catch (err: any) {
      console.warn(`   Transcription failed — using title only`)
    }
  } catch (err: any) {
    if (err.isSlideshow) {
      console.log('1. Slideshow detected — using vision...')
      const slideshow = await extractSlideshow(url)
      transcript = slideshow.transcript
      title = slideshow.title
      thumbnailUrl = slideshow.thumbnailUrl
      console.log(`   Title: ${title}`)
    } else {
      console.error(`   Failed: ${err.message}`)
      return
    }
  }

  console.log('3. Parsing places...')
  const parsedPlaces = await parsePlaces(transcript, title)
  if (!parsedPlaces.length) { console.warn('   No places found'); cleanup?.(); return }
  console.log(`   Found ${parsedPlaces.length} place(s)`)

  console.log('4. Geocoding & saving...')
  for (const parsed of parsedPlaces) {
    const geo = await geocodePlace(parsed)
    if (!geo) { console.warn(`   ⚠️  Could not geocode "${parsed.name}"`); continue }

    const { data: place, error } = await supabase.from('places').insert({
      user_id: TARGET_USER_ID,
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
    }).select().single()

    if (error) { console.warn(`   ⚠️  Save failed: ${error.message}`); continue }
    console.log(`   ✅ Saved: "${place.name}" in ${place.city}`)
  }

  cleanup?.()
}

async function run() {
  for (const url of URLS) {
    await processUrl(url)
  }
  console.log('\n✅ All done!')
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1) })

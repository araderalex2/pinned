import dotenv from 'dotenv'
dotenv.config({ override: true })
import { createClient } from '@supabase/supabase-js'
import { downloadAudio } from './src/services/extractor'
import { transcribeAudio } from './src/services/transcribe'
import { parsePlaces } from './src/services/placeParser'
import { geocodePlace } from './src/services/geocoder'
import { extractSlideshow } from './src/services/slideshowExtractor'

const url = process.argv[2]
if (!url) { console.error('Usage: npx tsx test-pipeline.ts <url>'); process.exit(1) }

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function run() {
  let transcript = ''
  let title: string | null = null
  let thumbnailUrl: string | null = null
  let cleanup: (() => void) | null = null

  try {
    console.log('\n1. Downloading audio...')
    const media = await downloadAudio(url)
    thumbnailUrl = media.thumbnailUrl
    title = media.title
    cleanup = media.cleanup
    console.log(`   Thumbnail: ${thumbnailUrl}`)
    console.log(`   Title: ${title}`)

    console.log('\n2. Transcribing...')
    try {
      transcript = await transcribeAudio(media.audioPath)
      console.log(`   "${transcript.slice(0, 200)}..."`)
    } catch (err: any) {
      console.warn(`   Transcription failed (${err.message}) — falling back to title-only`)
    }
  } catch (err: any) {
    if (err.isSlideshow) {
      console.log('\n1. Photo slideshow detected — using Playwright vision...')
      const slideshow = await extractSlideshow(url)
      transcript = slideshow.transcript
      title = slideshow.title
      thumbnailUrl = slideshow.thumbnailUrl
      console.log(`   Title: ${title}`)
      console.log(`   Vision output:\n${transcript.slice(0, 500)}...`)
    } else {
      throw err
    }
  }

  console.log('\n3. Extracting places...')
  const parsedPlaces = await parsePlaces(transcript, title)
  if (!parsedPlaces.length) { console.error('   No places found'); cleanup?.(); process.exit(1) }
  console.log(`   Found ${parsedPlaces.length} place(s)`)
  parsedPlaces.forEach((p, i) => {
    console.log(`\n   [${i + 1}] ${p.name} — ${p.city}, ${p.country}`)
    console.log(`       Category: ${p.category}`)
    console.log(`       ${p.description}`)
    p.highlights?.forEach(h => console.log(`       • ${h}`))
  })

  console.log('\n4. Geocoding & saving...')
  const { data: users } = await supabase.auth.admin.listUsers()
  const userId = users?.users?.[0]?.id
  if (!userId) { console.error('   No users found'); cleanup?.(); process.exit(1) }

  let saved = 0
  for (const parsed of parsedPlaces) {
    const geo = await geocodePlace(parsed)
    if (!geo) { console.warn(`   ⚠️  Could not geocode "${parsed.name}" — skipping`); continue }
    console.log(`   Geocoded: ${geo.name} — ${geo.address}`)

    const { data: place, error } = await supabase.from('places').insert({
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
    }).select().single()

    if (error || !place) { console.warn(`   ⚠️  Save failed for "${parsed.name}": ${error?.message}`); continue }
    console.log(`   ✅ Saved: "${place.name}" in ${place.city}`)
    saved++
  }

  cleanup?.()
  console.log(`\n✅ Done — ${saved}/${parsedPlaces.length} places pinned`)
}

run().catch(err => { console.error('\n❌ Error:', err.message); process.exit(1) })

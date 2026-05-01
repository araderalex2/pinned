import type { ParsedPlace } from './placeParser'

export interface GeocodedPlace {
  googlePlaceId: string
  name: string
  address: string
  city: string
  country: string
  lat: number
  lng: number
  photoUrls: string[]
  openingHours: string[]
  phoneNumber: string | null
}

export async function geocodePlace(parsed: ParsedPlace): Promise<GeocodedPlace | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY!
  const textQuery = [parsed.name, parsed.neighborhood, parsed.city].filter(Boolean).join(' ')

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.photos,places.regularOpeningHours,places.nationalPhoneNumber',
    },
    body: JSON.stringify({ textQuery }),
  })

  if (!res.ok) return null

  const data = await res.json() as {
    places?: Array<{
      id: string
      displayName: { text: string }
      formattedAddress: string
      location: { latitude: number; longitude: number }
      addressComponents: Array<{ longText: string; types: string[] }>
      photos?: Array<{ name: string }>
      regularOpeningHours?: { weekdayDescriptions: string[] }
      nationalPhoneNumber?: string
    }>
  }

  if (!data.places?.length) return geocodeFallback(parsed, key)

  const top = data.places[0]

  // Check if Google's result name plausibly matches what we searched for
  const resultName = top.displayName.text.toLowerCase()
  const searchName = parsed.name.toLowerCase()
  const nameWords = searchName.split(/\s+/).filter(w => w.length > 2)
  const isMatch = nameWords.some(w => resultName.includes(w)) || resultName.includes(searchName)

  if (!isMatch) {
    console.log(`   Google returned "${top.displayName.text}" for "${parsed.name}" — name mismatch, using address fallback`)
    return geocodeFallback(parsed, key)
  }

  const comps = top.addressComponents ?? []
  const getComp = (type: string) =>
    comps.find(c => c.types.includes(type))?.longText ?? ''

  const city = getComp('locality') || getComp('administrative_area_level_1') || parsed.city
  const country = getComp('country') || parsed.country

  // Fetch up to 2 photo URLs from Google Places
  const photoUrls: string[] = []
  for (const photo of (top.photos ?? []).slice(0, 2)) {
    try {
      const photoRes = await fetch(
        `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=1200&key=${key}&skipHttpRedirect=true`
      )
      if (photoRes.ok) {
        const photoData = await photoRes.json() as { photoUri?: string }
        if (photoData.photoUri) photoUrls.push(photoData.photoUri)
      }
    } catch { }
  }

  return {
    googlePlaceId: top.id,
    name: top.displayName.text,
    address: top.formattedAddress,
    city,
    country,
    lat: top.location.latitude,
    lng: top.location.longitude,
    photoUrls,
    openingHours: top.regularOpeningHours?.weekdayDescriptions ?? [],
    phoneNumber: top.nationalPhoneNumber ?? null,
  }
}

// Fallback: geocode just the neighborhood/address to get coordinates, use parsed name, no photos
async function geocodeFallback(parsed: ParsedPlace, key: string): Promise<GeocodedPlace | null> {
  const query = [parsed.neighborhood, parsed.city, parsed.country].filter(Boolean).join(' ')
  if (!query) return null

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.location,places.formattedAddress,places.addressComponents',
    },
    body: JSON.stringify({ textQuery: query }),
  })

  if (!res.ok) return null
  const data = await res.json() as { places?: Array<{ location: { latitude: number; longitude: number }; formattedAddress: string; addressComponents: Array<{ longText: string; types: string[] }> }> }
  if (!data.places?.length) return null

  const top = data.places[0]
  const comps = top.addressComponents ?? []
  const getComp = (type: string) => comps.find(c => c.types.includes(type))?.longText ?? ''
  const city = getComp('locality') || getComp('administrative_area_level_1') || parsed.city
  const country = getComp('country') || parsed.country

  return {
    googlePlaceId: '',
    name: parsed.name,
    address: parsed.neighborhood ? `${parsed.neighborhood}, ${city}` : top.formattedAddress,
    city,
    country,
    lat: top.location.latitude,
    lng: top.location.longitude,
    photoUrls: [],
    openingHours: [],
    phoneNumber: null,
  }
}

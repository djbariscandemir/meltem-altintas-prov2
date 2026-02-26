import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

let _client = null
function getClient() {
  if (_client) return _client
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL ve key tanımlı olmalı')
  _client = createClient(supabaseUrl, supabaseKey)
  return _client
}

export async function upsertListing(row) {
  const supabase = getClient()
  if (!row.listing_url) return { error: 'listing_url gerekli', data: null }

  const payload = {
    title: row.title ?? 'İlan',
    price: row.price ?? null,
    listing_status: row.listing_status ?? 'satilik',
    listing_date: row.listing_date ?? null,
    property_type: row.property_type ?? 'konut',
    property_subtype: row.property_subtype ?? 'daire',
    rooms: row.rooms ?? null,
    net_area: row.net_area ?? null,
    gross_area: row.gross_area ?? null,
    floor: row.floor ?? null,
    building_age: row.building_age ?? null,
    heating_type: row.heating_type ?? null,
    owner_type: row.owner_type ?? null,
    owner_name: row.owner_name ?? null,
    city: row.city ?? null,
    district: row.district ?? null,
    neighborhood: row.neighborhood ?? null,
    listing_url: row.listing_url,
  }

  const { data: existing } = await supabase
    .from('listings')
    .select('id')
    .eq('listing_url', row.listing_url)
    .limit(1)
    .maybeSingle()

  if (existing?.id) {
    const { data, error } = await supabase
      .from('listings')
      .update(payload)
      .eq('id', existing.id)
      .select('id')
      .single()
    return { error, data, updated: true }
  }

  const { data, error } = await supabase.from('listings').insert({ ...payload, manual: false }).select('id').single()
  return { error, data, updated: false }
}

export async function upsertListings(rows) {
  const results = { inserted: 0, updated: 0, failed: 0 }
  for (const row of rows) {
    try {
      const { data, error, updated } = await upsertListing(row)
      if (error) {
        results.failed++
        if (process.env.DEBUG) console.warn('[supabase] upsert error:', row.listing_url, error.message)
        continue
      }
      if (updated) results.updated++
      else results.inserted++
    } catch (e) {
      results.failed++
      if (process.env.DEBUG) console.warn('[supabase] upsert exception:', row.listing_url, e.message)
    }
  }
  return results
}

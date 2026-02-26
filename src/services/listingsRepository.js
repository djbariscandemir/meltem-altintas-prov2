import { supabase } from '../utils/supabase'

const REVY_DETAIL_URL_REGEX = /^https?:\/\/(www\.)?revy\.com\.tr\/.*\/detay\/([a-f0-9-]+)/i

/**
 * Revy detay URL'sinden ilan ID'sini çıkarır.
 * @param {string} url - Revy ilan detay URL'si
 * @returns {{ valid: boolean, revyId?: string, error?: string }}
 */
export function parseRevyDetailUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL giriniz' }
  }
  const trimmed = url.trim()
  const match = trimmed.match(REVY_DETAIL_URL_REGEX)
  if (!match) {
    return { valid: false, error: 'Geçerli bir Revy ilan detay linki giriniz (revy.com.tr/.../detay/...)' }
  }
  return { valid: true, revyId: match[2] }
}

/**
 * Manuel ilan ekle (Revy linki ile). Stub kayıt: manual=true, parse_status=pending.
 * @param {string} revyDetailUrl - Revy ilan detay URL'si
 * @param {string} [initialNote] - Opsiyonel ilk not
 * @param {object} [formData] - Opsiyonel form alanları: title, price, description, category
 * @returns {{ success: boolean, duplicate?: boolean, listingId?: string, error?: string }}
 */
export async function addManualListing(revyDetailUrl, initialNote, formData = {}) {
  const parsed = parseRevyDetailUrl(revyDetailUrl)
  if (!parsed.valid) {
    return { success: false, error: parsed.error }
  }

  const { revyId } = parsed
  const listingUrl = revyDetailUrl.trim()

  if (!revyId) {
    return { success: false, error: 'Revy ilan ID\'si alınamadı' }
  }

  try {
    // Duplicate: aynı listing_url zaten varsa tekrar ekleme
    const { data: existing } = await supabase
      .from('listings')
      .select('id')
      .eq('listing_url', listingUrl)
      .maybeSingle()

    if (existing) {
      return { success: false, duplicate: true, error: 'Bu ilan zaten sistemde mevcut' }
    }

    const payload = {
      listing_url: listingUrl,
      external_id: revyId,
      source: 'manual',
      parse_status: 'pending',
      title: formData.title ?? null,
      price: formData.price ? Number(formData.price) || null : null,
      description: formData.description ?? null,
      property_category: formData.category ?? null,
      manual: true,
      priority: true
    }

    console.log('FORM DATA:', formData)
    console.log('INSERT PAYLOAD:', payload)

    const { data: inserted, error: insertError } = await supabase
      .from('listings')
      .insert([payload])
      .select()

    console.log('[listingsRepository] insert result:', { inserted, insertError })

    if (insertError) {
      console.error('[listingsRepository] addManualListing insert error:', insertError)
      return { success: false, error: insertError.message || 'İlan eklenirken hata oluştu' }
    }

    const listingId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id

    if (listingId && initialNote?.trim()) {
      const { error: noteError } = await supabase.from('notes').insert({
        listing_id: listingId,
        note_text: initialNote.trim(),
        is_completed: false
      })
      if (noteError) console.error('[listingsRepository] addManualListing note error:', noteError)
    }

    return { success: true, listingId }
  } catch (err) {
    console.error('[listingsRepository] addManualListing exception:', err)
    return { success: false, error: err.message || 'Beklenmeyen hata' }
  }
}

export async function fetchManualListings() {
  try {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('manual', true)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      console.error('[listingsRepository] fetchManualListings error:', error)
      return []
    }
    return data || []
  } catch (err) {
    console.error('[listingsRepository] fetchManualListings exception:', err)
    return []
  }
}

/**
 * Tek ilan detayı getir (ID ile). Manuel ilanlar dahil tüm ilanlar.
 * @param {string} listingId - UUID
 * @returns {{ data: object|null, error: object|null }}
 */
export async function fetchListingById(listingId) {
  const id = typeof listingId === 'string' ? listingId : String(listingId)
  console.log('[listingsRepository] fetchListingById listingId:', id)

  try {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      console.error('[listingsRepository] fetchListingById error:', error)
      return { data: null, error }
    }
    console.log('[listingsRepository] fetchListingById fetched data:', data)
    return { data, error: null }
  } catch (err) {
    console.error('[listingsRepository] fetchListingById exception:', err)
    return { data: null, error: err }
  }
}

export async function fetchAllListings() {
  try {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .order('listing_date', { ascending: false, nullsLast: true })
      .limit(100)

    if (error) {
      if (import.meta.env.DEV) console.warn('[listingsRepository]', error.message)
      return []
    }
    return data || []
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[listingsRepository]', err)
    return []
  }
}

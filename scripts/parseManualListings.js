/**
 * Manuel eklenen ilanlar için parse worker.
 * parse_status = 'pending' olan TÜM kayıtları işler.
 * Revy detay sayfasından başlık, fiyat, fotoğraflar, oda bilgisi parse eder.
 * Oturum düşmüşse ensureRevySession ile otomatik login yapar, kaldığı yerden devam eder.
 * Çalıştırma: npm run parse:manual
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import dotenv from 'dotenv'
import { ensureRevySession } from './crawler/ensureRevySession.js'

dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://akidlfqugftljfuhnjxn.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const STORAGE_STATE_PATH = './.auth/revy-storage-state.json'
const DELAY_BETWEEN_LISTINGS_MS = 4000
const GOTO_TIMEOUT_MS = 60000

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[parseManualListings] SUPABASE_SERVICE_ROLE_KEY gerekli (.env)')
  process.exit(0)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Öncelikli pending ilanları getir (priority=true, limit 5). Kolon yoksa [] döner. */
async function getPriorityListings() {
  try {
    const { data, error } = await supabase
      .from('listings')
      .select('id, listing_url, external_id')
      .eq('parse_status', 'pending')
      .eq('priority', true)
      .not('listing_url', 'is', null)
      .order('created_at', { ascending: true })
      .limit(5)

    if (error) {
      if (String(error.message || '').includes('priority') || String(error.message || '').includes('column')) {
        return []
      }
      console.error('[parseManualListings] getPriorityListings:', error.message)
      return []
    }
    return data || []
  } catch (err) {
    console.error('[parseManualListings] getPriorityListings:', err.message)
    return []
  }
}

/** Normal pending ilanları getir (priority=false veya null). Kolon yoksa tüm pending. */
async function getPendingListings() {
  try {
    const { data, error } = await supabase
      .from('listings')
      .select('id, listing_url, external_id')
      .eq('parse_status', 'pending')
      .not('listing_url', 'is', null)
      .or('priority.eq.false,priority.is.null')
      .order('created_at', { ascending: true })

    if (error) {
      if (String(error.message || '').includes('priority') || String(error.message || '').includes('column')) {
        return getPendingListingsFallback()
      }
      console.error('[parseManualListings] getPendingListings:', error.message)
      return []
    }
    return data || []
  } catch (err) {
    console.error('[parseManualListings] getPendingListings:', err.message)
    return []
  }
}

/** priority kolonu yoksa: tüm pending ilanları getir */
async function getPendingListingsFallback() {
  const { data, error } = await supabase
    .from('listings')
    .select('id, listing_url, external_id')
    .eq('parse_status', 'pending')
    .not('listing_url', 'is', null)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[parseManualListings] getPendingListingsFallback:', error.message)
    return []
  }
  return data || []
}

const LOGIN_REQUIRED = 'LOGIN_REQUIRED'
const REVY_HOME_URL = 'https://www.revy.com.tr/'

/** Detay sayfasında değilsek = login gerekli */
async function checkLoginRequired(page) {
  const currentUrl = page.url()
  if (currentUrl.includes('/app/portfoy/detay/')) return false
  return true
}

/** Tek ilan için Revy detay sayfasını parse et */
async function parseDetailPage(page, listingUrl) {
  await delay(randomInt(1500, 3000))
  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
  await delay(randomInt(1000, 2000))

  const currentUrl = page.url()
  if (currentUrl === REVY_HOME_URL || currentUrl === 'https://www.revy.com.tr') {
    throw new Error('REVY_REDIRECT_HOME')
  }

  const needsLogin = await checkLoginRequired(page)
  if (needsLogin) {
    throw new Error(LOGIN_REQUIRED)
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await delay(800)

  try {
    await page.waitForSelector('.price-container, p.description, .gallery img, img[src*="shbdn"], img[data-src]', { timeout: 20000 })
  } catch (e) {
    throw new Error('Beklenen eleman bulunamadı: ' + (e.message || 'timeout'))
  }

  let title = null
  let price = null
  let rooms = null
  let net_area = null
  let image_urls = []

  // Title
  try {
    const titleSelectors = ['p.description', 'h1', 'h1 span', '.title', '.property-title']
    for (const sel of titleSelectors) {
      const el = await page.$(sel)
      if (el) {
        const t = await el.evaluate(node => node.textContent?.trim() || null)
        if (t && !t.includes('Müşteri Seç')) {
          title = t
          break
        }
      }
    }
  } catch (_) {}

  // Price
  try {
    const priceSelectors = ['.price-container', '.price', '.price-wrapper', '[class*="price"]']
    for (const sel of priceSelectors) {
      const el = await page.$(sel)
      if (!el) continue
      const pt = await el.textContent().catch(() => null)
      if (!pt) continue
      const cleaned = pt.replace(/[^\d]/g, '')
      if (!cleaned) continue
      const p = Number(cleaned)
      if (!Number.isNaN(p) && p > 0) {
        price = p
        break
      }
    }
  } catch (_) {}

  // Rooms
  try {
    const roomIcon = await page.$('i.icon.icon-room-2')
    if (roomIcon) {
      const parentText = await roomIcon.evaluate(el => el.parentElement?.textContent?.trim() || null)
      if (parentText) {
        const m = parentText.match(/(\d+\+\d+)/)
        if (m) rooms = m[1]
      }
    }
  } catch (_) {}

  // Net area
  try {
    const areaIcon = await page.$('i.icon.icon-square')
    if (areaIcon) {
      const parentText = await areaIcon.evaluate(el => el.parentElement?.textContent?.trim() || null)
      if (parentText) {
        const areaMatch = parentText.match(/(\d+)\s*m[²2]?/i)
        if (areaMatch) {
          const n = Number(areaMatch[1])
          if (!isNaN(n) && n > 0) net_area = n
        }
      }
    }
  } catch (_) {}

  // Galeri
  const imageExtensionPattern = /\.(jpg|jpeg|png|webp)(\?|$)/i
  const blacklist = ['logo', 'icon', 'svg', 'badge', 'placeholder', 'avatar', 'revy.com.tr/images/', 'ui/']
  const allowedDomains = ['shbdn.com', 'sahibinden.com', 'cdn.', 'uploads.', 'cloudfront.net', 'amazonaws.com']

  try {
    const gallerySelectors = ['.gallery img', '.swiper img', '[class*="photo"] img', 'img[data-src]', 'img[src*="shbdn"]', 'img']
    let imgs = []
    for (const sel of gallerySelectors) {
      imgs = await page.$$(sel)
      if (imgs.length > 0) break
    }

    const foundUrls = new Set()
    for (const imgEl of imgs) {
      const urls = []
      const src = await imgEl.getAttribute('src').catch(() => null)
      if (src && src.startsWith('http')) urls.push(src.trim())
      const dataSrc = await imgEl.getAttribute('data-src').catch(() => null)
      if (dataSrc && dataSrc.startsWith('http')) urls.push(dataSrc.trim())
      const srcset = await imgEl.getAttribute('srcset').catch(() => null)
      if (srcset) {
        srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean).forEach(u => {
          if (u.startsWith('http')) urls.push(u.trim())
        })
      }
      for (const url of urls) {
        const ul = url.toLowerCase()
        if (blacklist.some(k => ul.includes(k))) continue
        if (!imageExtensionPattern.test(url)) continue
        if (!allowedDomains.some(d => ul.includes(d))) continue
        foundUrls.add(url)
      }
    }
    image_urls = Array.from(foundUrls)
  } catch (_) {}

  return { title, price, rooms, net_area, image_urls }
}

/** Başarılı parse: parse_status = 'parsed', priority = false, title, price, cover_image_url, image_urls güncelle */
async function markParsed(listingId, payload, wasPriority = false) {
  const update = {
    parse_status: 'parsed',
    parse_error: null,
    ...(wasPriority ? { priority: false } : {}),
    ...payload
  }
  let { error } = await supabase.from('listings').update(update).eq('id', listingId)
  if (error && (String(error.message || '').includes('priority') || String(error.message || '').includes('column'))) {
    const { priority, ...rest } = update
    const { error: err2 } = await supabase.from('listings').update(rest).eq('id', listingId)
    if (err2) throw new Error(err2.message)
    return
  }
  if (error) throw new Error(error.message)
}

/** Hata: parse_status = 'failed', parse_error = hata mesajı */
async function markFailed(listingId, errorMessage) {
  const msg = (errorMessage && String(errorMessage).slice(0, 500)) || 'Bilinmeyen hata'
  const { error } = await supabase
    .from('listings')
    .update({ parse_status: 'failed', parse_error: msg })
    .eq('id', listingId)
  if (error) console.error('[parseManualListings] markFailed:', error.message)
}

const IDLE_DELAY_MIN_SEC = 20
const IDLE_DELAY_MAX_SEC = 60

/** Tek batch işle (priority veya normal pending) */
async function processBatch(page, listings, isPriority) {
  let successCount = 0
  let failedCount = 0

  for (let i = 0; i < listings.length; i++) {
    const row = listings[i]
    const { id, listing_url } = row

    console.log(`${isPriority ? '[PRIORITY]' : '[NORMAL]'} Processing listing id: ${id}`)

    try {
      if (!listing_url) {
        await markFailed(id, 'listing_url boş')
        failedCount++
        console.error(`[ERROR] listing id: ${id}`, 'listing_url boş')
        continue
      }

      let parsed
      try {
        parsed = await parseDetailPage(page, listing_url)
      } catch (err) {
        const needsLogin = err.message === LOGIN_REQUIRED || err.message === 'REVY_REDIRECT_HOME'
        if (needsLogin) {
          console.log('[parseManualListings] Oturum düşmüş, otomatik login yapılıyor...')
          try {
            await ensureRevySession(page, { storageStatePath: STORAGE_STATE_PATH })
            console.log('[parseManualListings] Login başarılı, kaldığı yerden devam ediliyor.')
            parsed = await parseDetailPage(page, listing_url)
          } catch (loginErr) {
            const msg = loginErr.message || String(loginErr)
            console.error('[parseManualListings] Login başarısız:', msg)
            await markFailed(id, `Revy giriş başarısız: ${msg}`)
            failedCount++
            throw new Error('LOGIN_FAILED')
          }
        } else {
          throw err
        }
      }

      const payload = {}
      if (parsed.title != null) payload.title = parsed.title
      if (parsed.price != null) payload.price = parsed.price
      if (parsed.rooms != null) payload.rooms = parsed.rooms
      if (parsed.net_area != null) payload.net_area = parsed.net_area
      if (Array.isArray(parsed.image_urls) && parsed.image_urls.length > 0) {
        payload.image_urls = parsed.image_urls
        payload.cover_image_url = parsed.image_urls[0]
      }

      await markParsed(id, payload, isPriority)
      successCount++
      console.log(`[SUCCESS] listing id: ${id} (title: ${parsed.title ? 'var' : 'yok'}, images: ${(parsed.image_urls || []).length})`)
    } catch (err) {
      if (err.message !== 'LOGIN_FAILED') {
        failedCount++
        const msg = err.message || String(err)
        console.error(`[ERROR] listing id: ${id}`, msg)
        try {
          await markFailed(id, msg)
        } catch (markErr) {
          console.error(`[ERROR] listing id: ${id} markFailed hatası:`, markErr.message)
        }
      }
    } finally {
      console.log(`[END] listing id: ${id}`)
    }

    if (i < listings.length - 1) {
      await delay(DELAY_BETWEEN_LISTINGS_MS)
    }
  }

  return { successCount, failedCount }
}

/**
 * One iteration: process priority or pending batch. No idle delay. Exported for worker.js.
 * @returns {'priority'|'normal'|'none'} - what was processed (for worker delay logic)
 */
export async function processPendingListings() {
  const priority = await getPriorityListings()
  const pending = await getPendingListings()
  const hasPriority = priority.length > 0
  const hasPending = pending.length > 0
  if (!hasPriority && !hasPending) return 'none'

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  })
  const contextOptions = { viewport: { width: 1366, height: 768 } }
  if (existsSync(STORAGE_STATE_PATH)) {
    contextOptions.storageState = STORAGE_STATE_PATH
    console.log('[parseManualListings] Revy storage state kullanılıyor.')
  }
  const dir = dirname(STORAGE_STATE_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  try {
    if (hasPriority) {
      console.log(`[PRIORITY] ${priority.length} adet ilan işlenecek (hemen).`)
      await processBatch(page, priority, true)
      return 'priority'
    }
    console.log(`[NORMAL] ${pending.length} adet ilan işlenecek.`)
    await processBatch(page, pending, false)
    return 'normal'
  } finally {
    await browser.close()
  }
}

async function runWorkerLoop() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  })

  const contextOptions = { viewport: { width: 1366, height: 768 } }
  if (existsSync(STORAGE_STATE_PATH)) {
    contextOptions.storageState = STORAGE_STATE_PATH
    console.log('[parseManualListings] Revy storage state kullanılıyor.')
  }
  const dir = dirname(STORAGE_STATE_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  let totalSuccess = 0
  let totalFailed = 0

  while (true) {
    const priority = await getPriorityListings()
    const hasPriority = priority.length > 0

    if (hasPriority) {
      console.log(`[parseManualListings] ${priority.length} adet ÖNCELİKLİ ilan işlenecek.`)
      const { successCount, failedCount } = await processBatch(page, priority, true)
      totalSuccess += successCount
      totalFailed += failedCount
      continue
    }

    const pending = await getPendingListings()
    const hasPending = pending.length > 0

    if (hasPending) {
      console.log(`[parseManualListings] ${pending.length} adet normal pending ilan işlenecek.`)
      const { successCount, failedCount } = await processBatch(page, pending, false)
      totalSuccess += successCount
      totalFailed += failedCount
      continue
    }

    const idleSec = randomInt(IDLE_DELAY_MIN_SEC, IDLE_DELAY_MAX_SEC)
    console.log(`[parseManualListings] Bekleyen ilan yok. ${idleSec}s sonra tekrar kontrol edilecek.`)
    await delay(idleSec * 1000)
  }
}

async function main() {
  console.log('[parseManualListings] Worker başlatıldı. Sürekli çalışacak.')
  await runWorkerLoop()
}

main().catch(e => {
  console.error('[parseManualListings] Beklenmeyen hata:', e)
  process.exit(1)
})

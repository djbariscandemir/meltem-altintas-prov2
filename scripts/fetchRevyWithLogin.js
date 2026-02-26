// scripts/fetchRevyWithLogin.js
// Revy Batch Scraper - Güvenli, İnsan Davranışına Yakın Arka Plan Sistemi
//
// PRENSİPLER:
// - Revy'ye agresif istek atılmaz
// - Aynı anda sadece 1 ilan detay sayfası açılır
// - Tüm beklemeler random
// - Mevcut ilanlar tekrar yazılmaz
// - Kaldığı yerden devam edebilir
// - Sürekli login kalmaz, ara ara girip çıkar

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import dotenv from "dotenv";
import { ensureRevySession } from "./crawler/ensureRevySession.js";

// ========== ENVIRONMENT VARIABLES ==========
// .env dosyasından değişkenleri yükle
dotenv.config();

// ========== KONFIGÜRASYON ==========
const REVY_PHONE = process.env.REVY_PHONE || "5322273212";
const REVY_PASSWORD = process.env.REVY_PASSWORD || "414615";
const SUPABASE_URL = "https://akidlfqugftljfuhnjxn.supabase.co";
const REVY_BASE_URL = 'https://www.revy.com.tr';
const STORAGE_STATE_PATH = './.auth/revy-storage-state.json';

// Service role key ZORUNLU - .env dosyasından okunmalı
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service role key kontrolü
console.log('[CONFIG] SERVICE ROLE KEY OK:', !!SUPABASE_SERVICE_ROLE_KEY);
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[CONFIG] ❌ SUPABASE_SERVICE_ROLE_KEY environment variable bulunamadı!');
  console.error('[CONFIG] Lütfen .env dosyasına SUPABASE_SERVICE_ROLE_KEY=your-key ekleyin');
  process.exit(1);
}

// Supabase client - SADECE service_role key ile (RLS bypass)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Storage işlemleri için aynı client kullanılacak (service_role ile)
const supabaseStorage = supabase;

// Supabase Storage bucket adı
const STORAGE_BUCKET = 'listing-images';

// Çalışma saatleri (09:00 - 22:00)
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;

// Günlük maksimum ilan limiti
const DAILY_MAX_LISTINGS = 100;

// HTTP istekleri arası global delay (saniye)
const HTTP_DELAY_MIN = 3;
const HTTP_DELAY_MAX = 7;

// ========== FORCE RUN KONTROLÜ ==========
const FORCE_RUN =
  process.env.FORCE_RUN === "true" ||
  process.env.FORCE_RUN === "1";

if (FORCE_RUN) {
  console.log('[CONFIG] ⚠️ FORCE_RUN aktif - Çalışma saatleri ve limitler bypass edilecek');
}

// ========== HELPER FONKSİYONLAR ==========

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(min, max) {
  const ms = randomInt(min * 1000, max * 1000);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function humanHttpDelay() {
  await randomDelay(HTTP_DELAY_MIN, HTTP_DELAY_MAX);
}

function isWithinWorkingHours() {
  // FORCE_RUN aktifse her zaman true dön
  if (FORCE_RUN) {
    return true;
  }

  const now = new Date();
  const hour = now.getHours();
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

function getNextWorkingWindow() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  const startMinutes = WORK_START_HOUR * 60;
  const endMinutes = WORK_END_HOUR * 60;

  // Çalışma saatindeyse bekleme yok
  if (timeInMinutes >= startMinutes && timeInMinutes < endMinutes) {
    return 0;
  }

  const nextTime = new Date(now);

  // Sabah öncesindeyse bugün 09:00'a kadar bekle
  if (timeInMinutes < startMinutes) {
    nextTime.setHours(WORK_START_HOUR, 0, 0, 0);
    return nextTime.getTime() - now.getTime();
  }

  // Akşam sonrasındaysa yarın 09:00'a kadar bekle
  nextTime.setDate(nextTime.getDate() + 1);
  nextTime.setHours(WORK_START_HOUR, 0, 0, 0);
  return nextTime.getTime() - now.getTime();
}

// ========== STATE YÖNETİMİ ==========

class BatchState {
  constructor() {
    this.sessionCount = 0;
    this.lastSessionEnd = null;
    this.dailyProcessed = 0;
    this.hourlyProcessed = 0;
    this.lastHourReset = new Date();
    this.lastDayReset = new Date();
    this.isBlocked = false;
    this.blockedUntil = null;
  }

  canStartSession() {
    // FORCE_RUN aktifse tüm kontrolleri bypass et
    if (FORCE_RUN) {
      return { canStart: true };
    }

    // Çalışma saatleri kontrolü
    if (!isWithinWorkingHours()) {
      return { canStart: false, reason: 'Çalışma saatleri dışında' };
    }

    // Blok kontrolü
    if (this.isBlocked && this.blockedUntil) {
      if (new Date() < this.blockedUntil) {
        return { canStart: false, reason: `Bloklanmış durumda. ${this.blockedUntil.toLocaleString('tr-TR')} tarihine kadar bekleniyor.` };
      } else {
        this.isBlocked = false;
        this.blockedUntil = null;
      }
    }

    // Günlük limit kontrolü
    this.resetCountersIfNeeded();
    if (this.dailyProcessed >= DAILY_MAX_LISTINGS) {
      return { canStart: false, reason: `Günlük limit (${DAILY_MAX_LISTINGS} ilan) doldu` };
    }

    // Saatlik limit kontrolü
    if (this.hourlyProcessed >= 30) {
      return { canStart: false, reason: 'Saatlik limit (30 ilan) doldu' };
    }

    // Session limit kontrolü (günde max 3 session)
    if (this.sessionCount >= 3) {
      const today = new Date().toDateString();
      const lastSessionDay = this.lastSessionEnd ? new Date(this.lastSessionEnd).toDateString() : null;
      if (today === lastSessionDay) {
        return { canStart: false, reason: 'Günlük session limiti (3) doldu' };
      } else {
        // Yeni gün, reset
        this.sessionCount = 0;
      }
    }

    // Son session'dan sonra bekleme süresi kontrolü
    if (this.lastSessionEnd) {
      const timeSinceLastSession = Date.now() - this.lastSessionEnd;
      const minWaitTime = 45 * 60 * 1000; // 45 dakika
      if (timeSinceLastSession < minWaitTime) {
        const remainingMinutes = Math.ceil((minWaitTime - timeSinceLastSession) / (60 * 1000));
        return { canStart: false, reason: `Son session'dan sonra ${remainingMinutes} dakika daha beklenmeli` };
      }
    }

    return { canStart: true };
  }

  resetCountersIfNeeded() {
    const now = new Date();
    
    // Saatlik reset
    if (now.getHours() !== this.lastHourReset.getHours() || 
        now.getTime() - this.lastHourReset.getTime() > 60 * 60 * 1000) {
      this.hourlyProcessed = 0;
      this.lastHourReset = now;
    }

    // Günlük reset
    if (now.toDateString() !== this.lastDayReset.toDateString()) {
      this.dailyProcessed = 0;
      this.sessionCount = 0;
      this.lastDayReset = now;
    }
  }

  startSession() {
    this.sessionCount++;
    this.resetCountersIfNeeded();
  }

  endSession() {
    this.lastSessionEnd = Date.now();
  }

  incrementProcessed() {
    this.dailyProcessed++;
    this.hourlyProcessed++;
  }

  setBlocked(until) {
    this.isBlocked = true;
    this.blockedUntil = until;
  }
}

// ========== BROWSER SETUP ==========

async function createBrowser() {
  // DEBUG_BROWSER=true olduğunda tarayıcı görünür, aksi halde headless
  const showBrowser = process.env.DEBUG_BROWSER === "true" || process.env.DEBUG_BROWSER === "1";
  const headless = !showBrowser;

  if (showBrowser) {
    console.log('[BROWSER] DEBUG_BROWSER aktif - Tarayıcı görünür modda açılacak');
  } else {
    console.log('[BROWSER] Headless mod - Tarayıcı arka planda çalışacak');
  }

  return await chromium.launch({
    headless: headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });
}

async function createContext(browser, storageStatePath = null) {
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // Eğer kaydedilmiş storageState varsa onu kullan
  if (storageStatePath && existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }

  return await browser.newContext(contextOptions);
}

async function saveStorageState(context, storageStatePath) {
  try {
    // Klasör yoksa oluştur
    const dir = dirname(storageStatePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    await context.storageState({ path: storageStatePath });
    console.log(`[STORAGE] Login state kaydedildi: ${storageStatePath}`);
  } catch (e) {
    console.error(`[STORAGE] State kaydetme hatası: ${e.message}`);
  }
}

// ========== LOGIN/LOGOUT ==========

async function login(page, hasStorageState = false) {
  try {
    // 1. Ana sayfayı aç
    console.log('REVY_HOME_OPENED');
    await humanHttpDelay();
    await page.goto(REVY_BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // URL kontrolü - sadece revy.com.tr domain'i olmalı
    const currentUrl = page.url();
    if (!currentUrl.startsWith(REVY_BASE_URL)) {
      throw new Error(`LOGIN_FAILED: Beklenmeyen domain açıldı: ${currentUrl}`);
    }

    // 2. Giriş butonunu kontrol et (sağ üstte)
    const loginButtonSelectors = [
      'a:has-text("Giriş")',
      'button:has-text("Giriş")',
      '[aria-label*="Giriş"]'
    ];

    let loginButton = null;
    for (const selector of loginButtonSelectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          loginButton = element;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // 3. Login butonu yoksa ve storageState varsa → zaten login, skip et
    if (!loginButton) {
      if (hasStorageState) {
        // Zaten login durumunda, login akışını skip et
        console.log('[LOGIN] Login butonu bulunamadı ancak storageState mevcut - Zaten login durumunda');
        
        // Login durumunu doğrula (portföy/kullanıcı alanları var mı?)
        const isAlreadyLoggedIn = await page.evaluate(() => {
          const portfolioLinks = document.querySelectorAll('a[href*="/portfoy"], a[href*="/portfolio"]');
          const userMenus = document.querySelectorAll('[class*="user"], [class*="profile"], [aria-label*="Kullanıcı"]');
          const phoneInputs = document.querySelectorAll('input[type="tel"]');
          const visiblePhoneInputs = Array.from(phoneInputs).filter(input => {
            const style = window.getComputedStyle(input);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
          
          return (portfolioLinks.length > 0 || userMenus.length > 0) && visiblePhoneInputs.length === 0;
        });

        if (isAlreadyLoggedIn) {
          console.log('LOGIN_SUCCESS (storageState ile zaten login)');
          return true;
        } else {
          // storageState var ama login geçersiz görünüyor, yeniden login gerekli
          console.log('[LOGIN] storageState mevcut ancak login durumu geçersiz - Yeniden login gerekli');
          throw new Error('LOGIN_FAILED: storageState mevcut ancak login durumu geçersiz');
        }
      } else {
        // Login butonu yok ve storageState de yok → hata
        throw new Error('LOGIN_FAILED: Giriş butonu bulunamadı ve storageState mevcut değil');
      }
    }

    // 4. Login butonu bulundu → normal login akışı
    await loginButton.click();
    console.log('LOGIN_BUTTON_CLICKED');
    await page.waitForTimeout(1500);

    // 3. Login modal/panel açıldı mı kontrol et
    try {
      await page.waitForSelector('input[type="tel"], input[name*="phone"], input[type="password"]', { timeout: 5000 });
      console.log('LOGIN_MODAL_OPENED');
    } catch (e) {
      throw new Error('LOGIN_FAILED: Login modal açılmadı');
    }

    // 4. Telefon inputunu bul ve doldur
    const phoneInput = await page.$('input[type="tel"], input[name*="phone"]');
    if (!phoneInput) {
      throw new Error('LOGIN_FAILED: Telefon input bulunamadı');
    }

    await phoneInput.fill('');
    await phoneInput.type(REVY_PHONE, { delay: 100 });
    await page.waitForTimeout(500);

    // 5. Şifre inputunu bul ve doldur
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) {
      throw new Error('LOGIN_FAILED: Şifre input bulunamadı');
    }

    await passwordInput.fill(REVY_PASSWORD);
    console.log('CREDENTIALS_FILLED');
    await randomDelay(0.4, 0.8);

    // 6. Modal içindeki Giriş/Devam Et butonuna tıkla
    const submitButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("Giriş")',
      'button:has-text("Devam Et")',
      'button:has-text("Giriş Yap")'
    ];

    let submitButton = null;
    for (const selector of submitButtonSelectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          submitButton = element;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!submitButton) {
      throw new Error('LOGIN_FAILED: Giriş submit butonu bulunamadı');
    }

    await submitButton.click();
    await page.waitForTimeout(2000);

    // 7. Login başarı kontrolü
    // Modal DOM'dan kaybolmalı VEYA portföy/kullanıcı alanları görünmeli
    const loginSuccess = await page.evaluate(() => {
      // Modal'ın kaybolduğunu kontrol et
      const modals = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"]');
      const visibleModals = Array.from(modals).filter(modal => {
        const style = window.getComputedStyle(modal);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });

      // Telefon input'larının görünür olmadığını kontrol et
      const phoneInputs = document.querySelectorAll('input[type="tel"]');
      const visiblePhoneInputs = Array.from(phoneInputs).filter(input => {
        const style = window.getComputedStyle(input);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });

      // Portföy veya kullanıcı alanlarının görünür olduğunu kontrol et
      const portfolioLinks = document.querySelectorAll('a[href*="/portfoy"], a[href*="/portfolio"]');
      const userMenus = document.querySelectorAll('[class*="user"], [class*="profile"], [aria-label*="Kullanıcı"]');

      return (visibleModals.length === 0 && visiblePhoneInputs.length === 0) ||
             (portfolioLinks.length > 0 || userMenus.length > 0);
    });

    if (!loginSuccess) {
      // 5 saniye daha bekle ve tekrar kontrol et
      await page.waitForTimeout(5000);
      const loginSuccessRetry = await page.evaluate(() => {
        const phoneInputs = document.querySelectorAll('input[type="tel"]');
        const visiblePhoneInputs = Array.from(phoneInputs).filter(input => {
          const style = window.getComputedStyle(input);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        return visiblePhoneInputs.length === 0;
      });

      if (!loginSuccessRetry) {
        throw new Error('LOGIN_FAILED: Login başarısız - Modal hala görünür veya kullanıcı alanları görünmüyor');
      }
    }

    console.log('LOGIN_SUCCESS');
    return true;

  } catch (e) {
    console.error('LOGIN_FAILED:', e.message);
    throw new Error(`LOGIN_FAILED: ${e.message}`);
  }
}

async function logout(page) {
  try {
    // Çıkış butonunu bul ve tıkla
    const logoutSelectors = [
      'button:has-text("Çıkış")',
      'a:has-text("Çıkış")',
      '[aria-label*="Çıkış"]'
    ];

    for (const selector of logoutSelectors) {
      try {
        const logoutButton = await page.$(selector);
        if (logoutButton && await logoutButton.isVisible()) {
          await logoutButton.click();
          await page.waitForTimeout(2000);
          console.log('[LOGOUT] ✅ Çıkış yapıldı');
          return;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.log('[LOGOUT] Çıkış butonu bulunamadı, browser kapatılacak');
  }
}

// ========== DAVRANIŞ SİMÜLASYONU ==========

async function simulateHumanBehavior(page) {
  // Random scroll
  const scrollAmount = randomInt(200, 800);
  await page.evaluate((amount) => {
    window.scrollBy(0, amount);
  }, scrollAmount);
  
  await randomDelay(1, 2);

  // %10 ihtimalle geri çık
  if (Math.random() < 0.1) {
    await page.goBack();
    await randomDelay(1, 2);
    return true; // Geri çıkıldı
  }

  return false; // Normal devam
}

// ========== İLAN PARSE ==========

async function scrapeListingFromDetailPage(page, listingUrl) {
  try {
    // Sayfaya git
    await humanHttpDelay();
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1, 2);

    // Scroll yap (SPA render için)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(1, 2);

    // DOM yüklenmesini bekle
    await page.waitForSelector('.price-container', { timeout: 15000 });
    await randomDelay(0.5, 1);

    // URL'den listing_id çıkar
    const urlMatch = listingUrl.match(/\/detay\/([a-f0-9-]+)/i);
    const listingId = urlMatch ? urlMatch[1] : null;

    // Parse değişkenleri
    let title = null;
    let price = null;
    let rooms = null;
    let net_area = null;
    let floor = null;
    let property_category = null;
    let source = null;
    let is_active = null;
    let listing_type = null;
    let phone_numbers = [];
    let cover_image_url = null;

    // Title
    try {
      const titleEl = await page.$('p.description');
      if (titleEl) {
        const titleText = await titleEl.evaluate(el => el.textContent?.trim() || null);
        if (titleText && !titleText.includes('Müşteri Seç')) {
          title = titleText;
        }
      }
    } catch (e) {}

    // Price
    try {
      const priceEl = await page.$('.price-container');
      if (priceEl) {
        const priceText = await priceEl.textContent().catch(() => null);
        if (priceText) {
          const cleaned = priceText.replace(/[^\d]/g, '');
          if (cleaned) {
            price = Number(cleaned);
            if (Number.isNaN(price) || price === 0) price = null;
          }
        }
      }
    } catch (e) {}

    // Rooms
    try {
      const roomIcon = await page.$('i.icon.icon-room-2');
      if (roomIcon) {
        const parentText = await roomIcon.evaluate(el => el.parentElement?.textContent?.trim() || null);
        if (parentText) {
          const roomMatch = parentText.match(/(\d+\+\d+)/);
          if (roomMatch) rooms = roomMatch[1];
        }
      }
    } catch (e) {}

    // Net area
    try {
      const areaIcon = await page.$('i.icon.icon-square');
      if (areaIcon) {
        const parentText = await areaIcon.evaluate(el => el.parentElement?.textContent?.trim() || null);
        if (parentText) {
          const areaMatch = parentText.match(/(\d+)\s*m[²2]?/i);
          if (areaMatch) {
            const areaNum = Number(areaMatch[1]);
            if (!isNaN(areaNum) && areaNum > 0) net_area = areaNum;
          }
        }
      }
    } catch (e) {}

    // Floor
    try {
      const floorIcon = await page.$('i.icon.icon-floor');
      if (floorIcon) {
        const parentText = await floorIcon.evaluate(el => el.parentElement?.textContent?.trim() || null);
        if (parentText) floor = parentText;
      }
    } catch (e) {}

    // Property category
    try {
      const typeEl = await page.$('span.type');
      if (typeEl) {
        const typeText = await typeEl.evaluate(el => el.textContent?.trim() || null);
        if (typeText) property_category = typeText;
      }
    } catch (e) {}

    // is_active
    try {
      const activeEl = await page.$('span.text-success');
      const passiveEl = await page.$('span.text-danger');
      if (activeEl) {
        const activeText = await activeEl.evaluate(el => el.innerText?.trim() || null);
        if (activeText && activeText.includes('Aktif İlan')) is_active = true;
      } else if (passiveEl) {
        const passiveText = await passiveEl.evaluate(el => el.innerText?.trim() || null);
        if (passiveText && passiveText.includes('Pasif İlan')) is_active = false;
      }
    } catch (e) {}

    // listing_type
    try {
      const typeText = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        for (const span of spans) {
          const text = span.innerText?.trim() || '';
          if (text === 'Satılık') return 'satilik';
          if (text === 'Kiralık') return 'kiralik';
        }
        return null;
      });
      if (typeText) listing_type = typeText;
    } catch (e) {}

    // phone_numbers
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      for (const link of phoneLinks) {
        const href = await link.getAttribute('href').catch(() => null);
        if (href && href.startsWith('tel:')) {
          const phoneNumber = href.replace('tel:', '').trim();
          if (phoneNumber && !phone_numbers.includes(phoneNumber)) {
            phone_numbers.push(phoneNumber);
          }
        }
      }
    } catch (e) {}

    // Source
    try {
      const ownershipText = await page.evaluate(() => {
        const label = Array.from(document.querySelectorAll('div')).find(el => el.textContent.trim() === 'İlan Sahipliği');
        if (label && label.nextElementSibling) {
          return label.nextElementSibling.textContent.trim();
        }
        return null;
      });
      if (ownershipText) {
        const text = ownershipText.toLowerCase();
        if (text.includes('sahibinden') || text.includes('mülk sahibi')) {
          source = 'sahibinden';
        } else if (text.includes('emlak') || text.includes('ofis')) {
          source = 'emlak_ofisi';
        } else {
          source = 'fsbo';
        }
      }
    } catch (e) {}
    if (!source) source = 'fsbo';

    // Galeri fotoğraflarını topla - Kapak fotoğrafı ASLA karar kriteri değil
    // Her ilan için detay sayfasına gir, galeri DOM'unu parse et
    let image_urls = [];
    let cover_found = false;
    let gallery_images_found = 0;
    let accepted_images = 0;
    let rejected_images = 0;
    let gallery_selector_used = 'fallback';
    
    try {
      // Extension kontrolü için regex pattern
      // URL sonunda veya query string öncesinde extension olmalı
      // Kabul edilenler: jpg, jpeg, png, webp
      const imageExtensionPattern = /\.(jpg|jpeg|png|webp)(\?|$)/i;
      
      // Kesin blacklist (kesinlikle ele)
      const strictBlacklist = [
        'logo',
        'icon',
        'svg',
        'badge',
        'placeholder',
        'customer-select',
        'add-btn',
        'feature',
        'search',
        'notes',
        '/images/icons/',
        '/images/logo',
        '/large-icons/',
        'revy.com.tr/images/',
        'ui/',
        '/ui/',
        'avatar',
        'profile'
      ];
      
      // Kesin whitelist (kesinlikle kabul et)
      const strictWhitelist = [
        'shbdn.com/photos',
        'sahibinden.com/photos',
        'jpg',
        'jpeg',
        'png',
        'webp'
      ];
      
      // Domain kontrolü (esnek)
      const allowedDomains = [
        'i0.shbdn.com',
        'i1.shbdn.com',
        'i2.shbdn.com',
        'i3.shbdn.com',
        'shbdn.com',
        'sahibinden.com',
        'cdn.',
        'uploads.',
        'storage.',
        'cloudfront.net',
        'amazonaws.com'
      ];
      
      // 1️⃣ Çoklu galeri selector dene (sırayla)
      const gallerySelectors = [
        '.gallery img',
        '.swiper img',
        '.carousel img',
        '[class*="photo"] img',
        '[class*="image"] img',
        'img[data-src]',
        'img[src*="shbdn.com"]',
        'img[src*="sahibinden"]'
      ];
      
      const foundUrls = new Set();
      let galleryElements = [];
      
      // Galeri selector'ları sırayla dene
      for (const selector of gallerySelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            galleryElements = elements;
            gallery_selector_used = selector;
            console.log(`[SCRAPER] Galeri bulundu (${selector}): ${elements.length} element`);
            break;
          }
        } catch (e) {
          // Selector bulunamadı, devam et
          continue;
        }
      }
      
      // 2️⃣ Fallback: Eğer galeri spesifik element bulunamadıysa, tüm img elementlerini kullan
      if (galleryElements.length === 0) {
        galleryElements = await page.$$('img');
        gallery_selector_used = 'fallback (all img)';
        console.log(`[SCRAPER] Galeri selector bulunamadı, fallback kullanılıyor: ${galleryElements.length} element`);
      }
      
      gallery_images_found = galleryElements.length;
      
      // Her img elementini işle
      for (const imgEl of galleryElements) {
        try {
          // Tüm olası URL kaynaklarını topla (src, data-src, srcset)
          const candidateUrls = new Set();
          
          // src attribute
          const src = await imgEl.getAttribute('src').catch(() => null);
          if (src && src.startsWith('http')) {
            candidateUrls.add(src.trim());
          }
          
          // data-src attribute (lazy loading)
          const dataSrc = await imgEl.getAttribute('data-src').catch(() => null);
          if (dataSrc && dataSrc.startsWith('http')) {
            candidateUrls.add(dataSrc.trim());
          }
          
          // srcset attribute
          const srcset = await imgEl.getAttribute('srcset').catch(() => null);
          if (srcset) {
            const srcsetUrls = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
            srcsetUrls.forEach(url => {
              if (url.startsWith('http')) {
                candidateUrls.add(url.trim());
              }
            });
          }
          
          // Her candidate URL'i kontrol et ve ekle
          for (const url of candidateUrls) {
            const urlLower = url.toLowerCase();
            
            // 2️⃣ Fallback iyileştir: Kesin blacklist kontrolü
            const isStrictlyBlacklisted = strictBlacklist.some(keyword => urlLower.includes(keyword));
            if (isStrictlyBlacklisted) {
              rejected_images++;
              continue;
            }
            
            // 2️⃣ Fallback iyileştir: Kesin whitelist kontrolü (öncelikli)
            const isStrictlyWhitelisted = strictWhitelist.some(keyword => urlLower.includes(keyword));
            if (isStrictlyWhitelisted) {
              // Whitelist'te varsa direkt kabul et (extension kontrolü yap)
              const hasValidExtension = imageExtensionPattern.test(url);
              if (hasValidExtension) {
                const urlBeforeAdd = foundUrls.size;
                foundUrls.add(url);
                if (foundUrls.size > urlBeforeAdd) {
                  accepted_images++;
                }
              } else {
                rejected_images++;
              }
              continue;
            }
            
            // Extension kontrolü - regex ile (jpg, jpeg, png, webp)
            const hasValidExtension = imageExtensionPattern.test(url);
            if (!hasValidExtension) {
              rejected_images++;
              continue;
            }
            
            // Domain kontrolü (en az bir geçerli domain içermeli)
            const hasValidDomain = allowedDomains.some(domain => urlLower.includes(domain));
            if (hasValidDomain) {
              // Set kullanıldığı için aynı URL birden fazla kez eklenmez
              const urlBeforeAdd = foundUrls.size;
              foundUrls.add(url);
              // Sadece yeni eklenen URL'ler için sayacı artır
              if (foundUrls.size > urlBeforeAdd) {
                accepted_images++;
              }
            } else {
              rejected_images++;
            }
          }
        } catch (e) {
          // Tek bir img elementinde hata olsa bile devam et
          continue;
        }
      }
      
      // Bulunan URL'leri array'e çevir
      image_urls = Array.from(foundUrls);
      
      // cover_image_url kontrolü (sadece log için, karar kriteri değil)
      cover_found = image_urls.length > 0;
      
      // 5️⃣ LOG EKLE (ZORUNLU)
      console.log(`[SCRAPER] listing_id=${listingId || 'N/A'}`);
      console.log(`[SCRAPER] gallery_selector_used=${gallery_selector_used}`);
      console.log(`[SCRAPER] total_imgs_found=${gallery_images_found}`);
      console.log(`[SCRAPER] accepted_images=${accepted_images}`);
      console.log(`[SCRAPER] rejected_images=${rejected_images}`);
      console.log(`[SCRAPER] cover_found=${cover_found}`);
      
      // 4️⃣ cover_image_url: Eğer cover yoksa image_urls[0]
      // Kapak fotoğrafı ASLA karar kriteri değil, sadece görselleştirme için
      cover_image_url = image_urls.length > 0 ? image_urls[0] : null;
      
      if (image_urls.length > 0) {
        console.log(`[IMAGE] ✅ ${image_urls.length} gerçek ilan fotoğrafı bulundu`);
      } else {
        console.log(`[IMAGE] ⚠️ Galeri fotoğrafı bulunamadı (gallery_images_found=${gallery_images_found}, accepted_images=${accepted_images}, rejected_images=${rejected_images})`);
      }
    } catch (e) {
      console.warn(`[PARSE] Image URL toplama hatası: ${e.message}`);
      console.log(`[IMAGE] ⚠️ Galeri parse hatası`);
      cover_image_url = null;
      image_urls = [];
    }

    // Listing date
    let listing_date = null;
    try {
      const dateText = await page.evaluate(() => {
        const label = Array.from(document.querySelectorAll('div')).find(el => el.textContent.trim() === 'İlan Tarihi');
        if (label && label.nextElementSibling) {
          return label.nextElementSibling.textContent.trim();
        }
        return null;
      });
      if (dateText) {
        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (dateMatch) {
          const [, day, month, year] = dateMatch;
          listing_date = `${year}-${month}-${day}`;
        }
      }
    } catch (e) {}
    if (!listing_date) {
      listing_date = new Date().toISOString().split('T')[0];
    }

    // FULL ilan kontrolü: Aşağıdaki alanların TAMAMI dolu olmalı
    const requiredFields = {
      title: title,
      price: price,
      rooms: rooms,
      net_area: net_area,
      property_category: property_category,
      status: is_active !== null // is_active boolean olmalı (null değil)
    };

    const isFull = Object.values(requiredFields).every(value => 
      value !== null && value !== undefined && value !== ''
    );

    const parseStatus = isFull ? 'full' : 'partial';

    // Tüm fotoğrafları Supabase Storage'a yükle
    // 1) Foto upload işleminden sonra oluşan public URL'leri bir array'de topla
    const uploadedImageUrls = [];
    
    // 1) Bir ilan işlenirken: Eğer image_urls IS NULL VEYA array_length(image_urls, 1) < 3
    //    VEYA image_urls Supabase URL içermiyorsa → status FULL olsa bile fotoğraf upload sürecini ZORLA çalıştır
    const existing = await checkIfListingExists(listingId, listingUrl);
    
    // image_urls kontrolü
    const hasImageUrls = existing && existing.image_urls && Array.isArray(existing.image_urls);
    const imageUrlsLength = hasImageUrls ? existing.image_urls.length : 0;
    const hasSupabaseUrls = hasImageUrls && existing.image_urls.some(url => url && url.startsWith('http'));
    const hasValidCoverImage = existing && existing.cover_image_url && existing.cover_image_url.startsWith('http');
    
    // Upload yapılmalı mı?
    // - image_urls NULL ise
    // - image_urls.length < 3 ise
    // - image_urls Supabase URL içermiyorsa
    // - cover_image_url Supabase URL değilse
    // → ZORLA upload yap (status FULL olsa bile)
    const shouldUpload = !existing || 
                         !hasImageUrls || 
                         imageUrlsLength < 3 || 
                         !hasSupabaseUrls || 
                         !hasValidCoverImage;
    
    if (shouldUpload && existing && existing.parse_status === 'full') {
      console.log(`[PARSE] ⚠️ Status FULL ama image_urls eksik/eksik, upload ZORLA çalıştırılıyor`);
      console.log(`[PARSE]   - image_urls: ${hasImageUrls ? imageUrlsLength : 'NULL'}`);
      console.log(`[PARSE]   - Supabase URL var mı: ${hasSupabaseUrls}`);
      console.log(`[PARSE]   - cover_image_url: ${hasValidCoverImage ? 'Var' : 'Yok/Eksik'}`);
    }
    
    // Galeri fotoğraflarını Supabase Storage'a yükle
    // Kapak fotoğrafı kontrolü YOK - sadece image_urls.length kontrolü
    if (image_urls && image_urls.length > 0 && listingId) {
      if (shouldUpload) {
        console.log(`[PARSE] 📸 ${image_urls.length} galeri fotoğrafı bulundu, Supabase Storage'a yükleniyor...`);
        
        let uploadedCount = 0;
        for (let i = 0; i < image_urls.length; i++) {
          const revyImageUrl = image_urls[i];
          if (!revyImageUrl) continue;
          
          try {
            const supabaseUrl = await uploadImageToSupabase(page, revyImageUrl, listingId, i);
            // 2) Her başarılı upload sonrası array'e ekle
            if (supabaseUrl && supabaseUrl.startsWith('http')) {
              uploadedImageUrls.push(supabaseUrl);
              uploadedCount++;
              
              // Rate limit için kısa bekleme
              if (i < image_urls.length - 1) {
                await randomDelay(0.5, 1);
              }
            } else {
              console.warn(`[PARSE] ⚠️ Foto ${i + 1}/${image_urls.length} upload başarısız: ${revyImageUrl.substring(0, 60)}...`);
            }
          } catch (e) {
            // Upload hatası olsa bile batch crash etme, skip et
            console.error(`[PARSE] Foto ${i + 1}/${image_urls.length} upload exception: ${e.message}`);
            continue;
          }
        }
        
        console.log(`[PARSE] ✅ ${uploadedCount}/${image_urls.length} foto Supabase Storage'a yüklendi`);
        if (uploadedImageUrls.length > 0) {
          console.log(`[PARSE] 📷 Cover image URL: ${uploadedImageUrls[0].substring(0, 80)}...`);
        }
        
        // Eğer hiç foto upload edilemediyse
        if (uploadedCount === 0) {
          console.warn(`[PARSE] ⚠️ Hiç foto upload edilemedi (gallery_images_found=${gallery_images_found}, accepted_images=${accepted_images})`);
        }
      } else {
        // Mevcut Supabase URL'leri kullan
        console.log(`[PARSE] ℹ️ image_urls zaten Supabase URL, upload atlanıyor`);
        if (existing.image_urls && Array.isArray(existing.image_urls) && existing.image_urls.length > 0) {
          // Mevcut image_urls Supabase URL'leri içeriyor mu kontrol et
          const hasSupabaseUrls = existing.image_urls.some(url => url && url.startsWith('http'));
          if (hasSupabaseUrls) {
            const existingSupabaseUrls = existing.image_urls.filter(url => url && url.startsWith('http'));
            uploadedImageUrls.push(...existingSupabaseUrls);
            console.log(`[PARSE] ℹ️ Mevcut ${existingSupabaseUrls.length} Supabase URL kullanılıyor`);
          }
        } else if (existing.cover_image_url && existing.cover_image_url.startsWith('http')) {
          // Sadece cover_image_url varsa onu kullan
          uploadedImageUrls.push(existing.cover_image_url);
          console.log(`[PARSE] ℹ️ Mevcut cover_image_url kullanılıyor`);
        }
      }
    } else {
      // Galeri fotoğrafı yok - bu normal, ilan yine de kaydedilecek
      console.log(`[PARSE] ℹ️ Galeri fotoğrafı bulunamadı (gallery_images_found=${gallery_images_found}, accepted_images=${accepted_images})`);
      console.log(`[PARSE] ℹ️ İlan yine de kaydedilecek (kapak fotoğrafı kontrolü YOK)`);
    }

    // 3) cover_image_url: image_urls[0] ile birebir senkron olmalı
    //    image_urls boşsa cover_image_url null yapılmalı
    //    Kapak fotoğrafı ASLA karar kriteri değil, sadece görselleştirme için
    const finalCoverImageUrl = uploadedImageUrls.length > 0 ? uploadedImageUrls[0] : null;
    
    // 4) FULL kontrolü yalnızca: photos_exist, critical_fields_complete, valid_image_urls koşulları birlikte sağlanıyorsa
    //    accepted_images >= 1 → FULL (kapak fotoğrafı kontrolü YOK)
    const fullCheckResult = await determineFullStatus({
      imageUrls: uploadedImageUrls,
      coverImageUrl: finalCoverImageUrl,
      hasCriticalFields: isFull
    });
    
    // 6️⃣ FULL / PARTIAL kararı:
    // - accepted_images >= 1 → PARTIAL veya FULL (diğer alanlara bağlı)
    // - accepted_images === 0 → PARTIAL
    // Kapak fotoğrafı kontrolü YOK
    let finalParseStatus = fullCheckResult.isFull ? 'full' : 'partial';
    
    // Eğer accepted_images === 0 ise kesinlikle PARTIAL
    if (uploadedImageUrls.length === 0) {
      finalParseStatus = 'partial';
      console.log(`[SCRAPER] accepted_images=0 → PARTIAL (foto yok)`);
    }
    
    // Final log
    console.log(`[SCRAPER] Final: listing_id=${listingId || 'N/A'}, accepted_images=${uploadedImageUrls.length}, status=${finalParseStatus.toUpperCase()}`);

    // 3) Supabase upsert sırasında image_urls: uploadedImageUrls ekle
    const payload = {
      listing_id: listingId,
      title: title,
      price: price,
      listing_date: listing_date,
      listing_status: is_active ? 'active' : 'passive',
      source: source,
      owner_type: source === 'sahibinden' ? 'fsbo' : 'office',
      property_category: property_category,
      rooms: rooms ? String(rooms).trim() : null,
      net_area: net_area,
      floor: floor ? String(floor).trim() : null,
      listing_url: listingUrl,
      // 3) cover_image_url: image_urls[0] ile birebir senkron
      cover_image_url: finalCoverImageUrl,
      // 3) image_urls: uploadedImageUrls
      image_urls: uploadedImageUrls.length > 0 ? uploadedImageUrls : null,
      is_active: is_active,
      listing_type: listing_type,
      phone_numbers: phone_numbers.length > 0 ? phone_numbers : null,
      // 4) status = uploadedImageUrls.length > 0 ? 'FULL' : 'PARTIAL'
      parse_status: finalParseStatus
    };

    return payload;
  } catch (e) {
    console.error(`[PARSE] Hata: ${e.message}`);
    return null;
  }
}

// ========== SUPABASE STORAGE İŞLEMLERİ ==========

// Revy image URL'ini fetch edip Supabase Storage'a yükle
// Dosya adı: listings/{listing_id}/{index}.jpg
async function uploadImageToSupabase(page, imageUrl, listingId, imageIndex) {
  try {
    // Service role key kontrolü
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[STORAGE] ❌ SUPABASE_SERVICE_ROLE_KEY bulunamadı, upload yapılamıyor');
      throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable zorunlu');
    }
    
    if (!imageUrl || !listingId) {
      return null;
    }

    // URL'den extension'ı çıkar (jpg, jpeg, png, webp)
    // Örnek: https://example.com/image.jpg?size=large -> jpg
    const extensionMatch = imageUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
    const fileExtension = extensionMatch ? extensionMatch[1].toLowerCase() : 'jpg';
    
    // Storage path: listings/{listing_id}/{index}.{extension}
    const filePath = `listings/${listingId}/${imageIndex}.${fileExtension}`;

      // Önce dosya zaten var mı kontrol et (service_role ile)
      try {
        const { data: existingFiles, error: listError } = await supabaseStorage.storage
          .from(STORAGE_BUCKET)
          .list(`listings/${listingId}`, {
            limit: 100,
            offset: 0
          });

      if (!listError && existingFiles) {
        // Dosya zaten var mı kontrol et (extension farklı olabilir)
        const fileExists = existingFiles.some(file => {
          const fileNameWithoutExt = file.name.replace(/\.(jpg|jpeg|png|webp)$/i, '');
          return fileNameWithoutExt === String(imageIndex);
        });
        if (fileExists) {
          // Mevcut dosyayı bul
          const existingFile = existingFiles.find(file => {
            const fileNameWithoutExt = file.name.replace(/\.(jpg|jpeg|png|webp)$/i, '');
            return fileNameWithoutExt === String(imageIndex);
          });
          if (existingFile) {
            const existingFilePath = `listings/${listingId}/${existingFile.name}`;
            const { data: publicUrlData } = supabaseStorage.storage
              .from(STORAGE_BUCKET)
              .getPublicUrl(existingFilePath);
          
            if (publicUrlData?.publicUrl) {
              console.log(`[STORAGE] Image zaten mevcut: ${existingFilePath}`);
              return publicUrlData.publicUrl;
            }
          }
        }
      }
    } catch (e) {
      // List hatası önemli değil, upload'a devam et
      console.warn(`[STORAGE] Dosya kontrolü hatası (devam ediliyor): ${e.message}`);
    }

    // Image'ı fetch et (binary) - Playwright page context kullan (login cookie'leri ile)
    let imageBuffer = null;
    try {
      // page.request kullan (sayfayı değiştirmez, sadece request yapar)
      await humanHttpDelay();
      const response = await page.request.get(imageUrl, {
        timeout: 30000
      });
      
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }
      
      // Response body'yi buffer olarak al
      imageBuffer = await response.body();
      
      if (!imageBuffer || imageBuffer.length === 0) {
        console.warn(`[STORAGE] Image fetch başarısız (boş): ${imageUrl}`);
        return null;
      }
    } catch (e) {
      console.warn(`[STORAGE] Image fetch hatası (${imageUrl}): ${e.message}`);
      return null;
    }

    // Content-Type'ı extension'a göre belirle
    const contentTypeMap = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'webp': 'image/webp'
    };
    const contentType = contentTypeMap[fileExtension] || 'image/jpeg';
    
    // Supabase Storage'a yükle (service_role ile - RLS bypass)
    const { data, error } = await supabaseStorage.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, imageBuffer, {
        contentType: contentType,
        upsert: true, // Aynı dosya varsa üzerine yaz
        cacheControl: '3600'
      });

    if (error) {
      console.error(`[STORAGE] Upload hatası (${filePath}):`, error.message);
      if (error.message?.includes('row-level security') || error.message?.includes('RLS')) {
        console.error(`[STORAGE] ❌ RLS hatası - service_role key kontrol edilmeli`);
        console.error(`[STORAGE] ❌ SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY ? 'Mevcut' : 'YOK'}`);
        throw new Error(`RLS hatası: ${error.message}`);
      }
      return null;
    }

    // Public URL'yi al
    const { data: publicUrlData } = supabaseStorage.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(filePath);

    if (publicUrlData?.publicUrl) {
      console.log(`[STORAGE] ✅ Image yüklendi: ${filePath}`);
      return publicUrlData.publicUrl;
    }

    return null;
  } catch (e) {
    console.error(`[STORAGE] Image upload exception (${imageUrl}):`, e.message);
    return null;
  }
}

// Tüm image URL'lerini Supabase Storage'a yükle
// SADECE image_urls_supabase boşsa upload yap
async function uploadListingImages(page, listing, existing = null) {
  try {
    // Eğer existing'de image_urls_supabase doluysa, upload yapma
    if (existing && existing.image_urls_supabase && Array.isArray(existing.image_urls_supabase) && existing.image_urls_supabase.length > 0) {
      console.log(`[STORAGE] image_urls_supabase zaten dolu, upload atlanıyor: ${listing.listing_id || 'N/A'}`);
      return {
        cover_image_url_supabase: existing.cover_image_url_supabase || existing.image_urls_supabase[0] || null,
        image_urls_supabase: existing.image_urls_supabase
      };
    }

    // Revy URL'leri yoksa upload yapma
    if (!listing.image_urls || !Array.isArray(listing.image_urls) || listing.image_urls.length === 0) {
      return {
        cover_image_url_supabase: null,
        image_urls_supabase: []
      };
    }

    console.log(`[STORAGE] ${listing.image_urls.length} image Supabase Storage'a yükleniyor...`);
    const supabaseUrls = [];
    
    // Her image'ı sırayla yükle (rate limit için)
    for (let i = 0; i < listing.image_urls.length; i++) {
      const imageUrl = listing.image_urls[i];
      if (!imageUrl) continue;

      const supabaseUrl = await uploadImageToSupabase(page, imageUrl, listing.listing_id, i);
      if (supabaseUrl) {
        supabaseUrls.push(supabaseUrl);
      }

      // Rate limit için kısa bekleme
      if (i < listing.image_urls.length - 1) {
        await randomDelay(0.5, 1);
      }
    }

    return {
      cover_image_url_supabase: supabaseUrls.length > 0 ? supabaseUrls[0] : null,
      image_urls_supabase: supabaseUrls
    };
  } catch (e) {
    console.error(`[STORAGE] uploadListingImages exception:`, e.message);
    return {
      cover_image_url_supabase: null,
      image_urls_supabase: []
    };
  }
}

// ========== SUPABASE İŞLEMLERİ ==========

function isActiveColumnError(err) {
  const msg = err?.message || '';
  return msg.includes('is_active') && (msg.includes('does not exist') || msg.includes('column'));
}

async function checkIfListingExists(listingId, listingUrl) {
  if (listingId) {
    const { data } = await supabase
      .from('listings')
      .select('id, parse_status, parse_attempts, title, price, rooms, net_area, property_category, is_active, cover_image_url, image_urls, image_urls_supabase, cover_image_url_supabase')
      .eq('listing_id', listingId)
      .single();
    return data;
  }
  if (listingUrl) {
    const { data } = await supabase
      .from('listings')
      .select('id, parse_status, parse_attempts, title, price, rooms, net_area, property_category, is_active, cover_image_url, image_urls, image_urls_supabase, cover_image_url_supabase')
      .eq('listing_url', listingUrl)
      .single();
    return data;
  }
  return null;
}

// FULL kontrol fonksiyonu - Tek bir fonksiyon
// URL'lerin erişilebilirliğini kontrol eder (HTTP 200)
async function checkImageUrlAccessibility(imageUrl) {
  try {
    // Node.js 18+ için fetch global, yoksa node-fetch kullanılabilir
    // Timeout için AbortController kullan
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(imageUrl, { 
      method: 'HEAD', 
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    return response.status === 200;
  } catch (e) {
    return false;
  }
}

// FULL karar fonksiyonu - Tek bir fonksiyon
async function determineFullStatus({ imageUrls, coverImageUrl, hasCriticalFields }) {
  // 1. image_urls NULL kontrolü
  if (!imageUrls || !Array.isArray(imageUrls)) {
    console.log(`[FULL_CHECK] image_count=0, valid_images=0, decision=PARTIAL (image_urls is NULL)`);
    return { isFull: false, reason: 'image_urls_is_null' };
  }
  
  const imageCount = imageUrls.length;
  
  // 2. image_urls array_length >= 3 kontrolü
  if (imageCount < 3) {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=0, decision=PARTIAL (image_count < 3)`);
    return { isFull: false, reason: 'image_count_less_than_3' };
  }
  
  // 3. URL'lerin Supabase storage public URL olması kontrolü
  const supabaseUrls = imageUrls.filter(url => 
    url && 
    typeof url === 'string' && 
    url.startsWith('http') && 
    (url.includes('supabase.co') || url.includes('storage.googleapis.com'))
  );
  
  if (supabaseUrls.length < 3) {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=${supabaseUrls.length}, decision=PARTIAL (supabase_urls < 3)`);
    return { isFull: false, reason: 'supabase_urls_less_than_3' };
  }
  
  // 4. URL'lerin HTTP 200 dönmesi kontrolü (en az %50 erişilebilir olmalı)
  const accessibilityChecks = await Promise.all(
    supabaseUrls.slice(0, Math.min(10, supabaseUrls.length)).map(url => checkImageUrlAccessibility(url))
  );
  
  const validImages = accessibilityChecks.filter(Boolean).length;
  const totalChecked = accessibilityChecks.length;
  const accessibilityRate = totalChecked > 0 ? (validImages / totalChecked) : 0;
  
  // En az %50 erişilebilir olmalı
  if (accessibilityRate < 0.5) {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=${validImages}/${totalChecked}, decision=PARTIAL (accessibility_rate < 50%)`);
    return { isFull: false, reason: 'accessibility_rate_below_50_percent', validImages, totalChecked };
  }
  
  // 5. cover_image_url = image_urls[0] senkronizasyonu
  const expectedCoverImage = supabaseUrls[0];
  if (coverImageUrl !== expectedCoverImage) {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=${validImages}, decision=PARTIAL (cover_image_url mismatch)`);
    return { isFull: false, reason: 'cover_image_url_mismatch', expectedCoverImage, actualCoverImage: coverImageUrl };
  }
  
  // 6. photos_exist, critical_fields_complete, valid_image_urls koşulları
  const photosExist = supabaseUrls.length >= 3;
  const criticalFieldsComplete = hasCriticalFields;
  const validImageUrls = accessibilityRate >= 0.5;
  
  if (photosExist && criticalFieldsComplete && validImageUrls) {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=${validImages}/${totalChecked}, decision=FULL`);
    return { isFull: true, reason: 'all_conditions_met', validImages, totalChecked };
  } else {
    console.log(`[FULL_CHECK] image_count=${imageCount}, valid_images=${validImages}/${totalChecked}, decision=PARTIAL (missing conditions: photos_exist=${photosExist}, critical_fields=${criticalFieldsComplete}, valid_urls=${validImageUrls})`);
    return { 
      isFull: false, 
      reason: 'missing_conditions', 
      photosExist, 
      criticalFieldsComplete, 
      validImageUrls,
      validImages,
      totalChecked
    };
  }
}

// Status belirleme fonksiyonu
// Foto varsa ABANDONED ASLA OLAMAZ
function determineListingStatus({ uploadedImages, hasCriticalFields, attempts }) {
  const MAX_ATTEMPTS = 4;
  const uploadedCount = uploadedImages ? uploadedImages.length : 0;
  
  // 1️⃣ Foto var + kritik alanlar var → FULL (ama determineFullStatus ile doğrulanmalı)
  if (uploadedCount > 0 && hasCriticalFields) {
    return { status: 'full', reason: 'photos_exist_and_critical_fields_complete' };
  }
  
  // 2️⃣ Foto var + bazı kritik alanlar eksik → PARTIAL
  if (uploadedCount > 0 && !hasCriticalFields) {
    return { status: 'partial', reason: 'photos_exist_but_critical_fields_incomplete' };
  }
  
  // 3️⃣ Foto yok + attempts < MAX → PARTIAL
  if (uploadedCount === 0 && attempts < MAX_ATTEMPTS) {
    return { status: 'partial', reason: 'no_photos_but_attempts_remaining' };
  }
  
  // 4️⃣ Foto yok + attempts >= MAX → ABANDONED
  if (uploadedCount === 0 && attempts >= MAX_ATTEMPTS) {
    return { status: 'abandoned', reason: 'no_photos_and_max_attempts_reached' };
  }
  
  // Fallback
  return { status: 'partial', reason: 'default_fallback' };
}

// Retry zamanını hesapla
function calculateNextRetry(parseAttempts) {
  const now = new Date();
  let nextRetry = new Date(now);

  if (parseAttempts === 1) {
    nextRetry.setHours(nextRetry.getHours() + 6); // 6 saat sonra
  } else if (parseAttempts === 2) {
    nextRetry.setHours(nextRetry.getHours() + 24); // 24 saat sonra
  } else if (parseAttempts === 3) {
    nextRetry.setDate(nextRetry.getDate() + 3); // 3 gün sonra
  } else if (parseAttempts >= 4) {
    return null; // abandoned, retry yok
  }

  return nextRetry.toISOString();
}

async function upsertListing(listing, existing = null) {
  try {
    // Conflict key: listing_id (UNIQUE constraint)
    const conflictKey = listing.listing_id ? 'listing_id' : 'listing_url';
    const conflictValue = listing.listing_id || listing.listing_url;
    
    if (!conflictValue) {
      throw new Error('listing_id veya listing_url zorunlu');
    }

    // Mevcut kaydı kontrol et (eğer parametre olarak verilmediyse)
    if (!existing) {
      existing = await checkIfListingExists(listing.listing_id, listing.listing_url);
    }

    const now = new Date().toISOString();
    const isFull = listing.parse_status === 'full';
    
    if (existing) {
      // Mevcut kayıt var
      const updates = {};
      
      // FULL ilana sahip alanlar ASLA overwrite edilmez
      const fullFields = ['title', 'price', 'rooms', 'net_area', 'property_category', 'is_active'];
      const existingIsFull = existing.parse_status === 'full';
      
      Object.keys(listing).forEach(key => {
        // parse_status, parse_attempts, last_parse_at, next_retry_at hariç
        if (['parse_status', 'parse_attempts', 'last_parse_at', 'next_retry_at'].includes(key)) {
          return;
        }
        
        // Eğer mevcut kayıt FULL ise ve bu alan FULL alanlardan biri ise, overwrite etme
        if (existingIsFull && fullFields.includes(key) && existing[key] !== null && existing[key] !== undefined) {
          return;
        }
        
        // cover_image_url: Eğer mevcut kayıtta NULL ise veya Supabase URL değilse güncelle
        if (key === 'cover_image_url') {
          const existingValue = existing[key];
          const newValue = listing[key];
          
          // Eğer mevcut değer NULL ise veya http ile başlamıyorsa (Revy URL ise) güncelle
          if (newValue && newValue.startsWith('http')) {
            if (!existingValue || !existingValue.startsWith('http')) {
              updates[key] = newValue;
              console.log(`[UPSERT] cover_image_url güncelleniyor: ${newValue.substring(0, 60)}...`);
            } else {
              console.log(`[UPSERT] cover_image_url zaten Supabase URL, güncellenmiyor`);
            }
          }
          return;
        }
        
        // image_urls: Eğer mevcut kayıtta NULL ise veya boş array ise güncelle
        if (key === 'image_urls') {
          const existingValue = existing[key];
          const newValue = listing[key];
          
          if (newValue && Array.isArray(newValue) && newValue.length > 0) {
            // Yeni değer Supabase URL'leri içeriyor mu kontrol et
            const hasSupabaseUrls = newValue.some(url => url && url.startsWith('http'));
            
            if (hasSupabaseUrls) {
              if (!existingValue || !Array.isArray(existingValue) || existingValue.length === 0) {
                updates[key] = newValue;
                console.log(`[UPSERT] image_urls güncelleniyor: ${newValue.length} foto`);
              } else {
                // Mevcut değer var ama Supabase URL değilse veya eksikse güncelle
                const existingHasSupabaseUrls = existingValue.some(url => url && url.startsWith('http'));
                const existingLength = existingValue.length;
                
                // Eğer mevcut image_urls < 3 ise veya Supabase URL içermiyorsa GÜNCELLE
                if (!existingHasSupabaseUrls || existingLength < 3) {
                  updates[key] = newValue;
                  console.log(`[UPSERT] image_urls güncelleniyor: ${existingLength} → ${newValue.length} foto (Supabase URL'lerle)`);
                } else if (newValue.length > existingLength) {
                  // Yeni değer daha fazla foto içeriyorsa güncelle
                  updates[key] = newValue;
                  console.log(`[UPSERT] image_urls güncelleniyor: ${existingLength} → ${newValue.length} foto (daha fazla foto)`);
                }
              }
            }
          }
          return;
        }
        
        // Supabase image URL'leri her zaman güncellenebilir (yeni upload varsa)
        if (key === 'cover_image_url_supabase' || key === 'image_urls_supabase') {
          if (listing[key] !== null && listing[key] !== undefined) {
            updates[key] = listing[key];
          }
          return;
        }
        
        // Sadece listing'deki değer null değilse ve mevcut kayıtta null ise güncelle
        if (listing[key] !== null && listing[key] !== undefined) {
          // Mevcut kayıtta null veya undefined ise güncelle
          if (existing[key] === null || existing[key] === undefined) {
            updates[key] = listing[key];
          }
        }
      });
      
      // Parse status ve retry mantığı - Foto kontrolü ile
      const existingImageUrls = existing.image_urls || [];
      const existingHasImages = Array.isArray(existingImageUrls) && existingImageUrls.length > 0;
      const newImageUrls = listing.image_urls || [];
      const newHasImages = Array.isArray(newImageUrls) && newImageUrls.length > 0;
      const hasUploadedImages = existingHasImages || newHasImages;
      
      // Mevcut attempts
      const currentAttempts = existing.parse_attempts || 0;
      // Foto varsa attempts artmaz, yoksa artar
      const newAttempts = hasUploadedImages ? currentAttempts : (currentAttempts + 1);
      
      // Status belirleme: Foto varsa ABANDONED ASLA OLAMAZ
      const statusResult = determineListingStatus({
        uploadedImages: newHasImages ? newImageUrls : (existingHasImages ? existingImageUrls : []),
        hasCriticalFields: isFull,
        attempts: newAttempts
      });
      
      updates.parse_status = statusResult.status;
      updates.parse_attempts = statusResult.status === 'full' ? 0 : newAttempts;
      updates.last_parse_at = now;
      
      if (statusResult.status === 'full') {
        updates.next_retry_at = null;
      } else if (statusResult.status === 'abandoned') {
        updates.next_retry_at = null;
      } else {
        // PARTIAL - retry zamanını hesapla
        const nextRetry = calculateNextRetry(newAttempts);
        updates.next_retry_at = nextRetry;
      }
      
      console.log(`[STATUS] uploaded=${hasUploadedImages ? (newHasImages ? newImageUrls.length : existingImageUrls.length) : 0}, attempts=${newAttempts} → ${statusResult.status.toUpperCase()} (${statusResult.reason})`);
      
      if (Object.keys(updates).length > 0) {
        let payload = { ...updates };
        let triedWithoutIsActive = false;
        while (true) {
          const { error } = await supabase
            .from('listings')
            .update(payload)
            .eq('id', existing.id);
          if (!error) break;
          if (!triedWithoutIsActive && isActiveColumnError(error)) {
            console.warn('[UPSERT] is_active kolonu listings tablosunda yok. is_active guncellenmeyecek. supabase-add-listing-fields.sql calistirin.');
            delete payload.is_active;
            triedWithoutIsActive = true;
            continue;
          }
          throw error;
        }
        
        const statusMsg = updates.parse_status?.toUpperCase() || existing.parse_status?.toUpperCase() || 'UNKNOWN';
        console.log(`✅ Supabase'e güncellendi: listing_id=${listing.listing_id || 'N/A'}, status=${statusMsg}, attempts=${updates.parse_attempts || existing.parse_attempts || 0}`);
        return { action: 'updated', id: existing.id, status: updates.parse_status || existing.parse_status };
      }
      
      console.log(`⏭️ Supabase'de zaten mevcut, güncelleme gerekmedi: listing_id=${listing.listing_id || 'N/A'}`);
      return { action: 'skipped', id: existing.id };
    } else {
      // Yeni kayıt ekle
      const newImageUrls = listing.image_urls || [];
      const newHasImages = Array.isArray(newImageUrls) && newImageUrls.length > 0;
      
      // 3) cover_image_url: image_urls[0] ile birebir senkron olmalı
      const expectedCoverImage = newImageUrls.length > 0 ? newImageUrls[0] : null;
      if (listing.cover_image_url !== expectedCoverImage) {
        listing.cover_image_url = expectedCoverImage;
      }
      
      // 4) FULL kontrolü yalnızca: photos_exist, critical_fields_complete, valid_image_urls koşulları birlikte sağlanıyorsa
      const fullCheckResult = await determineFullStatus({
        imageUrls: newImageUrls,
        coverImageUrl: expectedCoverImage,
        hasCriticalFields: isFull
      });
      
      // Status belirleme: Foto varsa ABANDONED ASLA OLAMAZ
      const statusResult = determineListingStatus({
        uploadedImages: newImageUrls,
        hasCriticalFields: isFull,
        attempts: fullCheckResult.isFull ? 0 : 1
      });
      
      // FULL kontrolü sonucuna göre final status
      let finalStatus = fullCheckResult.isFull ? 'full' : statusResult.status;
      
      // ABANDONED kontrolü: Sadece foto yoksa ve attempts >= 4 ise
      if (newImageUrls.length === 0 && !fullCheckResult.isFull) {
        finalStatus = 'partial'; // Yeni kayıt için abandoned olmaz, partial olur
      }
      
      const newAttempts = finalStatus === 'full' ? 0 : 1;
      const nextRetry = (finalStatus === 'full' || finalStatus === 'abandoned') ? null : calculateNextRetry(newAttempts);
      
      const newListing = {
        ...listing,
        cover_image_url: expectedCoverImage, // Senkronize edilmiş cover_image_url
        parse_status: finalStatus,
        parse_attempts: newAttempts,
        last_parse_at: now,
        next_retry_at: nextRetry,
        manual: false // Scraper'dan eklenen ilanlar
      };
      
      let payload = { ...newListing };
      let triedWithoutIsActive = false;
      let data, error;
      while (true) {
        const result = await supabase
          .from('listings')
          .upsert(payload, {
            onConflict: conflictKey
          })
          .select()
          .single();
        data = result.data;
        error = result.error;
        if (!error) break;
        if (!triedWithoutIsActive && isActiveColumnError(error)) {
          console.warn('[UPSERT] is_active kolonu listings tablosunda yok. is_active eklenmeyecek. supabase-add-listing-fields.sql calistirin.');
          delete payload.is_active;
          triedWithoutIsActive = true;
          continue;
        }
        throw error;
      }
      console.log(`✅ Supabase'e yazıldı: listing_id=${listing.listing_id || 'N/A'}, status=${listing.parse_status}, id=${data.id}`);
      return { action: 'inserted', id: data.id, status: listing.parse_status };
    }
  } catch (e) {
    console.error(`❌ [SUPABASE] Upsert hatası: ${e.message}`);
    return { action: 'error', error: e.message };
  }
}

// Partial (yeniden parse edilecek) ilanları getir
async function getPartialListings(limit = 20) {
  try {
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from('listings')
      .select(
        [
          'id',
          'listing_id',
          'listing_url',
          'parse_status',
          'parse_attempts',
          'next_retry_at',
          'title',
          'price',
          'rooms',
          'net_area',
          'property_category',
          'is_active',
          'image_urls_supabase',
          'cover_image_url_supabase'
        ].join(', ')
      )
      .eq('parse_status', 'partial')
      .lte('next_retry_at', nowIso)
      .lt('parse_attempts', 4)
      .order('next_retry_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('[SUPABASE] getPartialListings ERROR:', error.message);
      return [];
    }

    return data || [];
  } catch (e) {
    console.error('[SUPABASE] getPartialListings EXCEPTION:', e.message);
    return [];
  }
}

async function getNewListingsFromPortfolio(page, maxPages = 3, maxListingsPerPage = 20) {
  const allLinks = new Set();
  let currentPage = 1;
  let firstListingHref = null;

  const portfolioUrl = `${REVY_BASE_URL}/app/portfoy/ilanlar?export=0&fsbo=true&tab=all&area=my&advertisement_status=active`;

  await humanHttpDelay();
  await page.goto(portfolioUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(2, 4);

  while (currentPage <= maxPages) {
    // İlan linklerini topla
    try {
      await page.waitForSelector('a[href*="/app/portfoy/detay/"]', { timeout: 15000 });
      
      const rawLinks = await page.$$eval(
        'a[href*="/app/portfoy/detay/"]',
        (els, limit) => els.map(e => e.href).filter(Boolean).slice(0, limit),
        maxListingsPerPage
      );

      if (rawLinks.length === 0) break;

      const normalizedLinks = rawLinks.map(link => {
        try {
          const url = new URL(link);
          return `${url.origin}${url.pathname}`;
        } catch (e) {
          return link.split('?')[0].split('#')[0];
        }
      });

      if (currentPage === 1 && normalizedLinks.length > 0) {
        firstListingHref = normalizedLinks[0];
      }

      const before = allLinks.size;
      normalizedLinks.forEach(link => allLinks.add(link));
      const added = allLinks.size - before;

      console.log(`[PAGINATION] Sayfa ${currentPage}: ${rawLinks.length} link bulundu, ${added} yeni eklendi`);

      if (added === 0 && currentPage > 1) {
        console.log('[PAGINATION] Yeni link yok, durduruluyor');
        break;
      }

      if (currentPage < maxPages) {
        // Next butonunu bul ve tıkla
        const nextButton = await page.$('button:has-text("Sonraki"), a:has-text("Sonraki")');
        if (nextButton && await nextButton.isVisible()) {
          const currentFirstHref = normalizedLinks[0];
          await Promise.all([
            nextButton.click(),
            page.waitForFunction(
              (expectedHref) => {
                const links = Array.from(document.querySelectorAll('a[href*="/app/portfoy/detay/"]'));
                if (links.length === 0) return false;
                const firstHref = links[0].href;
                try {
                  const url = new URL(firstHref);
                  return `${url.origin}${url.pathname}` !== expectedHref;
                } catch (e) {
                  return firstHref.split('?')[0] !== expectedHref;
                }
              },
              currentFirstHref,
              { timeout: 15000 }
            )
          ]);
          await randomDelay(20, 40); // Sayfa değişimi bekleme (sayfa geçişi için ekstra)
          currentPage++;
        } else {
          break;
        }
      } else {
        break;
      }
    } catch (e) {
      console.error(`[PAGINATION] Hata: ${e.message}`);
      break;
    }
  }

  return Array.from(allLinks);
}

// ========== BATCH ÇALIŞMA ==========

async function runBatchSession(state) {
  const sessionStart = Date.now();
  const minSessionDuration = 10 * 60 * 1000; // 10 dakika
  const maxSessionDuration = 35 * 60 * 1000; // 35 dakika
  const sessionDuration = randomInt(minSessionDuration, maxSessionDuration);

  console.log(`\n[BATCH] Session başlatılıyor (${Math.round(sessionDuration / 60000)} dakika)`);
  
  const browser = await createBrowser();
  const hasStorageState = existsSync(STORAGE_STATE_PATH);
  const context = await createContext(browser, STORAGE_STATE_PATH);
  const page = await context.newPage();

  try {
    await ensureRevySession(page, { storageStatePath: STORAGE_STATE_PATH });
    await randomDelay(2, 4);

    // Partial ilanları öncelikli işle
    const partialListings = await getPartialListings();
    console.log(`[BATCH] ${partialListings.length} partial ilan bulundu`);

    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let fullCount = 0;
    let partialCount = 0;
    let abandonedCount = 0;

    // Partial ilanları işle - HER İLAN ANINDA YAZILIR
    for (const partialListing of partialListings) {
      if (Date.now() - sessionStart > sessionDuration) break;
      if (state.dailyProcessed >= 100 || state.hourlyProcessed >= 30) break;

      const listingUrl = partialListing.listing_url;
      console.log(`\n[BATCH] Partial ilan parse ediliyor: ${listingUrl.substring(0, 60)}...`);

      try {
        // 1. Detay sayfasına git ve parse et
        const listing = await scrapeListingFromDetailPage(page, listingUrl);
        
        if (!listing) {
          console.log(`⚠️ [BATCH] Parse başarısız, SKIP: ${listingUrl.substring(0, 60)}...`);
          continue; // Hata durumunda skip et, devam et
        }

        // 2. Image upload zaten scrapeListingFromDetailPage içinde yapıldı
        // cover_image_url ve image_urls alanları Supabase URL'leri ile dolu

        // 3. PARSE TAMAMLANINCA → HEMEN Supabase'e yaz
        console.log(`[BATCH] Parse tamamlandı, Supabase'e yazılıyor...`);
        const result = await upsertListing(listing, partialListing);
        
        // 4. Sonuç logla ve sayaçları güncelle
        if (result.action === 'inserted') {
          inserted++;
          state.incrementProcessed();
          processed++;
          if (result.status === 'full') fullCount++;
          else if (result.status === 'partial') partialCount++;
          else if (result.status === 'abandoned') abandonedCount++;
        } else if (result.action === 'updated') {
          updated++;
          state.incrementProcessed();
          processed++;
          if (result.status === 'full') fullCount++;
          else if (result.status === 'partial') partialCount++;
          else if (result.status === 'abandoned') abandonedCount++;
        } else if (result.action === 'skipped') {
          skipped++;
        } else if (result.action === 'error') {
          console.error(`❌ [BATCH] Supabase yazım hatası: ${result.error}`);
          // Hata olsa bile devam et
        }

      } catch (e) {
        // Parse veya yazma hatası - skip et ve devam et
        console.error(`❌ [BATCH] İlan işleme hatası (SKIP): ${e.message}`);
        continue;
      }

      // 4. Yazma sonrası bekleme (6-12 saniye random)
      await randomDelay(6, 12);
      
      // 5. Davranış simülasyonu (%10 ihtimal)
      if (Math.random() < 0.1) {
        await simulateHumanBehavior(page);
      }
    }

    // Yeni ilanları çek - Link toplama tamamlandıktan sonra her ilan anında işlenir
    console.log(`\n[BATCH] Portföy sayfasından link toplama başlatılıyor...`);
    const newLinks = await getNewListingsFromPortfolio(page, 3, 20);
    console.log(`[BATCH] ✅ Link toplama tamamlandı: ${newLinks.length} ilan linki bulundu\n`);

    // HER İLAN İÇİN AKIŞ: Parse → Hemen Supabase'e yaz
    for (let i = 0; i < newLinks.length; i++) {
      const link = newLinks[i];
      
      // Session ve limit kontrolleri
      if (Date.now() - sessionStart > sessionDuration) {
        console.log(`[BATCH] Session süresi doldu, durduruluyor`);
        break;
      }
      if (state.dailyProcessed >= 100 || state.hourlyProcessed >= 30) {
        console.log(`[BATCH] Günlük/saatlik limit doldu, durduruluyor`);
        break;
      }

      console.log(`\n[BATCH] [${i + 1}/${newLinks.length}] İlan işleniyor: ${link.substring(0, 60)}...`);

      try {
        // 1. URL'den listing_id çıkar ve Supabase'te var mı kontrol et
        const urlMatch = link.match(/\/detay\/([a-f0-9-]+)/i);
        const listingIdFromUrl = urlMatch ? urlMatch[1] : null;

        const existing = await checkIfListingExists(listingIdFromUrl, link);
        
        // Mevcut skip logic'i düzelt: FULL olsa bile image_urls eksikse işle
        if (existing && existing.parse_status === 'full') {
          // image_urls kontrolü
          const hasImageUrls = existing.image_urls && Array.isArray(existing.image_urls);
          const imageUrlsLength = hasImageUrls ? existing.image_urls.length : 0;
          const hasSupabaseUrls = hasImageUrls && existing.image_urls.some(url => url && url.startsWith('http'));
          const hasValidCoverImage = existing.cover_image_url && existing.cover_image_url.startsWith('http');
          
          // FULL statüsü yalnızca:
          // - image_urls.length >= 3
          // - VE cover_image_url public Supabase URL ise geçerli
          // Aksi halde işle (FULL olsa bile)
          if (hasImageUrls && imageUrlsLength >= 3 && hasSupabaseUrls && hasValidCoverImage) {
            console.log(`⏭️ [BATCH] İlan zaten mevcut ve FULL (${imageUrlsLength} foto), SKIP: ${link.substring(0, 60)}...`);
            skipped++;
            continue;
          } else {
            console.log(`⚠️ [BATCH] İlan FULL ama image_urls eksik/eksik, işleniyor: ${link.substring(0, 60)}...`);
            console.log(`   - image_urls: ${hasImageUrls ? imageUrlsLength : 'NULL'}`);
            console.log(`   - Supabase URL var mı: ${hasSupabaseUrls}`);
            console.log(`   - cover_image_url: ${hasValidCoverImage ? 'Var' : 'Yok/Eksik'}`);
          }
        }

        // 2. Detay sayfasına git ve parse et
        console.log(`[BATCH] Detay sayfasına gidiliyor ve parse ediliyor...`);
        const listing = await scrapeListingFromDetailPage(page, link);
        
        if (!listing) {
          console.log(`⚠️ [BATCH] Parse başarısız, SKIP: ${link.substring(0, 60)}...`);
          continue; // Hata durumunda skip et, devam et
        }

        // 3. Image upload zaten scrapeListingFromDetailPage içinde yapıldı
        // cover_image_url ve image_urls alanları Supabase URL'leri ile dolu

        // 4. PARSE TAMAMLANINCA → HEMEN Supabase'e yaz
        console.log(`[BATCH] Parse tamamlandı, Supabase'e yazılıyor...`);
        const result = await upsertListing(listing, existing);
        
        // 5. Sonuç logla ve sayaçları güncelle
        if (result.action === 'inserted') {
          inserted++;
          state.incrementProcessed();
          processed++;
          if (result.status === 'full') fullCount++;
          else if (result.status === 'partial') partialCount++;
          else if (result.status === 'abandoned') abandonedCount++;
        } else if (result.action === 'updated') {
          updated++;
          state.incrementProcessed();
          processed++;
          if (result.status === 'full') fullCount++;
          else if (result.status === 'partial') partialCount++;
          else if (result.status === 'abandoned') abandonedCount++;
        } else if (result.action === 'skipped') {
          skipped++;
        } else if (result.action === 'error') {
          console.error(`❌ [BATCH] Supabase yazım hatası: ${result.error}`);
          // Hata olsa bile devam et
        }

      } catch (e) {
        // Parse veya yazma hatası - skip et ve devam et
        console.error(`❌ [BATCH] İlan işleme hatası (SKIP): ${e.message}`);
        continue;
      }

      // 5. Yazma sonrası bekleme (6-12 saniye random)
      await randomDelay(6, 12);
      
      // 6. Davranış simülasyonu (%10 ihtimal)
      if (Math.random() < 0.1) {
        await simulateHumanBehavior(page);
      }
    }

    // Logout
    await logout(page);
    await randomDelay(1, 2);

    const sessionEnd = Date.now();
    const actualDuration = Math.round((sessionEnd - sessionStart) / 1000);

    console.log(`\n[BATCH] ========================================`);
    console.log(`[BATCH] Session tamamlandı:`);
    console.log(`[BATCH]   - Süre: ${actualDuration} saniye`);
    console.log(`[BATCH]   - İşlenen: ${processed}`);
    console.log(`[BATCH]   - Eklendi: ${inserted}`);
    console.log(`[BATCH]   - Güncellendi: ${updated}`);
    console.log(`[BATCH]   - Atlandı: ${skipped}`);
    console.log(`[BATCH] Parse Status İstatistikleri:`);
    console.log(`[BATCH]   - FULL: ${fullCount}`);
    console.log(`[BATCH]   - PARTIAL: ${partialCount}`);
    console.log(`[BATCH]   - ABANDONED: ${abandonedCount}`);
    console.log(`[BATCH] ========================================\n`);

    state.endSession();
    return { processed, inserted, updated, skipped, fullCount, partialCount, abandonedCount };

  } catch (e) {
    console.error(`[BATCH] Session hatası: ${e.message}`);
    
    // Rate limit / blok kontrolü
    if (e.message.includes('429') || e.message.includes('403') || 
        await page.$('text="captcha"') || await page.$('text="CAPTCHA"')) {
      const blockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 dakika
      state.setBlocked(blockedUntil);
      console.log(`[BATCH] ⚠️ Blok tespit edildi, 30 dakika bekleniyor`);
    }

    await logout(page);
    throw e;
  } finally {
    await browser.close();
  }
}

// ========== ANA DÖNGÜ ==========

async function main() {
  console.log('🚀 Revy Batch Scraper başlatılıyor...');
  if (FORCE_RUN) {
    console.log('[MAIN] ⚠️ FORCE_RUN modu aktif - Tüm kontroller bypass ediliyor');
  }
  
  const state = new BatchState();
  let consecutiveErrors = 0;

  while (true) {
    try {
      // Çalışma saatleri kontrolü (FORCE_RUN aktifse bypass)
      if (!FORCE_RUN && !isWithinWorkingHours()) {
        const waitTime = getNextWorkingWindow();
        const waitMinutes = Math.round(waitTime / 60000);
        console.log(`[MAIN] Çalışma saatleri dışında. ${waitMinutes} dakika sonra tekrar denenecek.`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Session başlatma kontrolü (FORCE_RUN aktifse bypass)
      const canStart = state.canStartSession();
      if (!canStart.canStart && !FORCE_RUN) {
        console.log(`[MAIN] Session başlatılamıyor: ${canStart.reason}`);
        
        if (state.isBlocked && state.blockedUntil) {
          const waitTime = state.blockedUntil.getTime() - Date.now();
          if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        } else {
          // Bir sonraki uygun zaman penceresini bekle
          const waitTime = getNextWorkingWindow();
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
      }

      // Session başlat
      state.startSession();
      await runBatchSession(state);
      
      consecutiveErrors = 0;
      
      // Session sonrası bekleme (45-90 dakika)
      const waitMinutes = randomInt(45, 90);
      console.log(`[MAIN] ${waitMinutes} dakika sonra tekrar session başlatılacak.`);
      await new Promise(resolve => setTimeout(resolve, waitMinutes * 60 * 1000));

    } catch (e) {
      consecutiveErrors++;
      console.error(`[MAIN] Hata: ${e.message}`);
      
      if (consecutiveErrors >= 3) {
        console.error('[MAIN] 3 ardışık hata, 1 saat bekleniyor.');
        await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
        consecutiveErrors = 0;
      } else {
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // 5 dakika bekle
      }
    }
  }
}

// ========== GRACEFUL SHUTDOWN ==========

process.on('SIGINT', () => {
  console.log('\n[BATCH] Durduruluyor...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[BATCH] Durduruluyor...');
  process.exit(0);
});

// ========== BAŞLAT ==========

main().catch(err => {
  console.error('[MAIN] Kritik hata:', err);
  process.exit(1);
});

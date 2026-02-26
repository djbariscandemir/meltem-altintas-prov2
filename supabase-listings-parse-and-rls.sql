-- =============================================================================
-- public.listings: parse_status, parse_error, source + UNIQUE + RLS
-- Manuel ilan ekleme akışı ve parse takibi için. Supabase SQL Editor'de çalıştırın.
-- =============================================================================

-- 1) Kolonlar (güvenli: IF NOT EXISTS)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'parse_status') THEN
    ALTER TABLE public.listings ADD COLUMN parse_status TEXT DEFAULT 'pending';
    RAISE NOTICE 'listings.parse_status eklendi';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'parse_error') THEN
    ALTER TABLE public.listings ADD COLUMN parse_error TEXT;
    RAISE NOTICE 'listings.parse_error eklendi';
  END IF;

  -- source: revy-listings veya canonical'da olabilir; yoksa ekle
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'source') THEN
    ALTER TABLE public.listings ADD COLUMN source TEXT DEFAULT 'manual';
    RAISE NOTICE 'listings.source eklendi';
  END IF;

  -- external_id: revy-listings'te olabilir
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'external_id') THEN
    ALTER TABLE public.listings ADD COLUMN external_id TEXT;
    RAISE NOTICE 'listings.external_id eklendi';
  END IF;

  -- priority: manuel ilanlar hemen işlensin (true), işlendikten sonra false
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'priority') THEN
    ALTER TABLE public.listings ADD COLUMN priority BOOLEAN DEFAULT false;
    RAISE NOTICE 'listings.priority eklendi';
  END IF;
END $$;

-- 2) UNIQUE: (source, external_id) — revy ve manual çakışmasın
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_listings_revy_external;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_external_id
  ON public.listings (source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;

-- 3) Indexler: parse_status, external_id
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_listings_parse_status
  ON public.listings (parse_status) WHERE parse_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_external_id
  ON public.listings (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_priority
  ON public.listings (priority) WHERE priority = true;

-- 4) RLS: listings INSERT sadece admin / broker
-- -----------------------------------------------------------------------------
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

-- Eski "tüm işlemlere izin" politikasını kaldır (varsa)
DROP POLICY IF EXISTS "Allow all operations on listings" ON public.listings;

-- SELECT: herkes (authenticated veya anon projeye göre)
CREATE POLICY "listings_select"
  ON public.listings FOR SELECT
  USING (true);

-- INSERT: sadece admin veya broker (profiles.rol)
CREATE POLICY "listings_insert_admin_broker"
  ON public.listings FOR INSERT
  WITH CHECK (
    (SELECT COALESCE(rol, 'user') FROM public.profiles WHERE id = auth.uid()) IN ('admin', 'broker')
  );

-- UPDATE / DELETE: mevcut davranışı korumak için tüm authenticated (ileride kısıtlanabilir)
CREATE POLICY "listings_update"
  ON public.listings FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "listings_delete"
  ON public.listings FOR DELETE
  USING (true);

-- Not: Service role (backend/script) RLS'i bypass eder; frontend anon/key ile giriş yapan kullanıcıya RLS uygulanır.
-- INSERT için auth.uid() kullanılıyor; giriş Supabase Auth ile yapılıyorsa auth.uid() = profiles.id olmalı.

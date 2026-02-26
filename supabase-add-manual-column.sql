-- listings tablosuna manual kolonu ekle
-- Manuel formdan eklenen ilanlar: manual = true
-- Scraper'dan eklenen ilanlar: manual = false

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'manual'
  ) THEN
    ALTER TABLE public.listings ADD COLUMN manual BOOLEAN DEFAULT false;
    RAISE NOTICE 'listings.manual kolonu eklendi';
  END IF;
END $$;

-- Mevcut manuel ilanları güncelle (source='manual' olanlar)
UPDATE public.listings SET manual = true WHERE source = 'manual';

CREATE INDEX IF NOT EXISTS idx_listings_manual
  ON public.listings(manual) WHERE manual = true;

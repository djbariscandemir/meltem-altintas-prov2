-- listings tablosuna priority kolonu ekle
-- Öncelikli manuel ilanlar: priority = true
-- İşlendikten sonra: priority = false

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = 'priority'
  ) THEN
    ALTER TABLE public.listings ADD COLUMN priority BOOLEAN DEFAULT false;
    RAISE NOTICE 'listings.priority kolonu eklendi';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_listings_priority
  ON public.listings(priority) WHERE priority = true;

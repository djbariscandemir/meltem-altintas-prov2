import { useState, useEffect } from 'react'
import { toast } from '../Toast/ToastContainer'
import { addManualListing, fetchManualListings } from '../../services/listingsRepository'
import { insertNote } from '../../services/notesRepository'
import ListingCard from '../Listings/ListingCard'
import DetailModal from '../Listings/DetailModal'
import './AddListing.css'

function AddListing({ user, onSuccess, onUpdateListings }) {
  const [url, setUrl] = useState('')
  const [initialNote, setInitialNote] = useState('')
  const [formData, setFormData] = useState({
    title: '',
    price: '',
    description: '',
    category: ''
  })
  const [loading, setLoading] = useState(false)
  const [manualListings, setManualListings] = useState([])
  const [loadingManual, setLoadingManual] = useState(true)
  const [selectedListing, setSelectedListing] = useState(null)
  const [showDetail, setShowDetail] = useState(false)

  const loadManualListings = async () => {
    setLoadingManual(true)
    const data = await fetchManualListings()
    setManualListings(data)
    setLoadingManual(false)
  }

  useEffect(() => {
    loadManualListings()
  }, [])

  useEffect(() => {
    if (selectedListing && manualListings?.length) {
      const u = manualListings.find(l => l.id === selectedListing.id)
      if (u) setSelectedListing(u)
    }
  }, [manualListings, selectedListing?.id])

  const handleSubmit = async (e) => {
    e.preventDefault()
    console.log('SUBMIT TRIGGERED')

    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      toast.error('Revy ilan linkini giriniz')
      return
    }

    setLoading(true)
    try {
      console.log('CALLING addManualListing', { url: trimmedUrl, formData })
      const result = await addManualListing(trimmedUrl, initialNote.trim() || undefined, formData)
      if (result.success) {
        toast.success('İlan sisteme eklendi. Worker arka planda işleyecek.')
        setUrl('')
        setInitialNote('')
        setFormData({ title: '', price: '', description: '', category: '' })
        if (typeof onSuccess === 'function') onSuccess()
        loadManualListings()
      } else if (result.duplicate) {
        toast.warning(result.error || 'Bu ilan zaten sistemde mevcut')
      } else {
        toast.error(result.error || 'İlan eklenirken hata oluştu')
      }
    } catch (err) {
      console.error('[AddListing] handleSubmit catch:', err)
      toast.error(err.message || 'Beklenmeyen hata')
    } finally {
      setLoading(false)
    }
  }

  const openDetail = (listing) => {
    setSelectedListing(listing)
    setShowDetail(true)
  }

  const closeDetail = () => {
    setShowDetail(false)
    const next = selectedListing && manualListings?.length
      ? manualListings.find(l => l.id === selectedListing.id)
      : null
    if (next) setSelectedListing(next)
    setTimeout(() => setSelectedListing(null), 300)
  }

  const handleCall = (listing) => {
    if (typeof onUpdateListings === 'function') onUpdateListings()
    toast.success(`Arama kaydedildi: ${listing.title}`)
  }

  const handleOpportunity = (listing) => {
    if (typeof onUpdateListings === 'function') onUpdateListings()
    loadManualListings()
  }

  const handleNoteSave = async (listingId, note) => {
    if (!note?.trim()) return
    try {
      await insertNote({ listing_id: listingId, note_text: note.trim(), reminder_at: null })
      toast.success('Not kaydedildi')
    } catch {
      toast.error('Not kaydedilirken hata oluştu')
    }
  }

  const getVisibleNotes = (listing) => {
    if (!user) return []
    if (user.role === 'broker' || user.role === 'admin') {
      return listing.notes || []
    }
    return (listing.notes || []).filter(note =>
      !note.isPrivate || note.userId === user.id
    )
  }

  return (
    <div className="add-listing-page">
      <div className="add-listing-card">
        <h2 className="add-listing-title">Manuel İlan Ekle (Revy Linki ile)</h2>
        <p className="add-listing-desc">
          Revy ilan detay sayfasının linkini yapıştırın. İlan sisteme stub olarak eklenir; başlık ve fotoğraflar arka planda güncellenecektir.
        </p>
        <form className="add-listing-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="revy-url">Revy ilan linki *</label>
            <input
              id="revy-url"
              type="text"
              placeholder="Revy ilan linki"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label htmlFor="form-title">Başlık</label>
            <input
              id="form-title"
              type="text"
              placeholder="İlan başlığı"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              disabled={loading}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label htmlFor="form-price">Fiyat</label>
            <input
              id="form-price"
              type="text"
              placeholder="Örn: 2500000"
              value={formData.price}
              onChange={(e) => setFormData({ ...formData, price: e.target.value })}
              disabled={loading}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label htmlFor="form-description">Açıklama</label>
            <textarea
              id="form-description"
              placeholder="İlan açıklaması"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              disabled={loading}
              rows={2}
            />
          </div>
          <div className="form-group">
            <label htmlFor="form-category">Kategori</label>
            <input
              id="form-category"
              type="text"
              placeholder="Örn: konut, ticari"
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              disabled={loading}
              autoComplete="off"
            />
          </div>
          <div className="form-group">
            <label htmlFor="ilk-not">İlk not (opsiyonel)</label>
            <textarea
              id="ilk-not"
              placeholder="Bu ilanla ilgili kısa not..."
              value={initialNote}
              onChange={(e) => setInitialNote(e.target.value)}
              disabled={loading}
              rows={3}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="submit-btn" disabled={loading || !url.trim()}>
              {loading ? 'Ekleniyor...' : 'Kaydet'}
            </button>
          </div>
        </form>
      </div>

      <section className="manual-listings-section">
        <h3 className="manual-listings-title">Manuel Eklenen İlanlar</h3>
        {loadingManual ? (
          <p className="manual-listings-loading">Yükleniyor...</p>
        ) : manualListings.length === 0 ? (
          <p className="manual-listings-empty">Henüz manuel ilan eklenmemiş.</p>
        ) : (
          <div className="manual-listings-list list-mode">
            {manualListings.map((listing) => {
              const visibleNotes = getVisibleNotes(listing)
              const photos = Array.isArray(listing.image_urls) && listing.image_urls.length > 0
                ? listing.image_urls
                : Array.isArray(listing.photos) ? listing.photos : []

              return (
                <ListingCard
                  key={listing.id}
                  listing={listing}
                  photos={photos}
                  visibleNotes={visibleNotes}
                  onOpportunity={handleOpportunity}
                  onDetail={openDetail}
                  onCall={handleCall}
                  onNoteSave={handleNoteSave}
                />
              )
            })}
          </div>
        )}
      </section>

      {showDetail && selectedListing && user && (
        <DetailModal
          user={user}
          listing={selectedListing}
          onClose={closeDetail}
          onCall={handleCall}
          onNoteSave={handleNoteSave}
        />
      )}
    </div>
  )
}

export default AddListing

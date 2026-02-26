import { Phone, Star, Eye, FileText, MapPin, Tag } from 'lucide-react'
import { formatPrice } from '../../utils/formatPrice'
import { getParseStatusLabel, getParseStatusClass } from '../../utils/parseStatusLabel'
import PhotoCarousel from '../PhotoCarousel'
import './ListMode.css'

function ListingCard({ listing, photos, visibleNotes, onOpportunity, onDetail, onCall, onNoteSave }) {
  return (
    <div 
      className={`list-card ${listing.isOpportunity ? 'opportunity' : ''} ${listing.isCustomStock ? 'custom-stock' : ''}`}
      onClick={() => onDetail?.(listing)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onDetail?.(listing)}
    >
      <div className="list-card-image">
        <PhotoCarousel
          photos={photos}
          variant="card"
          title={listing.title || 'İlan fotoğrafı'}
        />
        {listing.isOpportunity && (
          <div className="opportunity-badge-small">
            <Star size={14} strokeWidth={2.5} fill="currentColor" />
          </div>
        )}
        {listing.isCustomStock && (
          <div className="custom-stock-badge-small">
            <Star size={12} strokeWidth={2.5} fill="currentColor" style={{ marginRight: '4px' }} />
            Özel
          </div>
        )}
      </div>

      <div className="list-card-content">
        <div className="list-card-badges">
          {listing.manual === true && (
            <span className="type-badge manual-badge">Manuel</span>
          )}
          {listing.manual === false && (
            <span className="type-badge otomatik-badge">Otomatik</span>
          )}
          {listing.listing_status && (
            <span className="type-badge">
              {listing.listing_status === 'satilik' ? 'Satılık' : listing.listing_status === 'kiralik' ? 'Kiralık' : listing.listing_status}
            </span>
          )}
          {listing.property_type && (
            <span className="type-badge">{listing.property_type === 'konut' ? 'Konut' : 'Ticari'}</span>
          )}
          {listing.parse_status && getParseStatusLabel(listing.parse_status) && (
            <span className={`type-badge parse-status-badge ${getParseStatusClass(listing.parse_status)}`}>
              {getParseStatusLabel(listing.parse_status)}
            </span>
          )}
        </div>
        
        <h3 className="list-card-title">{listing.title}</h3>
        
        <div className="list-card-info">
          <div className="list-card-info-row">
            <span className="list-card-price">{formatPrice(listing.price)}</span>
            {listing.rooms && (
              <span className="list-card-rooms">{listing.rooms}</span>
            )}
            {(listing.net_area || listing.netArea) && (
              <span className="list-card-area">{(listing.net_area || listing.netArea)} m²</span>
            )}
          </div>
          <div className="list-card-info-row">
            {listing.district && listing.neighborhood && (
              <span className="list-card-location">{listing.district} / {listing.neighborhood}</span>
            )}
            {listing.district && !listing.neighborhood && (
              <span className="list-card-location">{listing.district}</span>
            )}
            {!listing.district && listing.neighborhood && (
              <span className="list-card-location">{listing.neighborhood}</span>
            )}
          </div>
          <div className="list-card-meta">
            {listing.property_subtype && (
              <span className="list-card-category">
                <Tag size={14} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }} />
                {listing.property_subtype}
              </span>
            )}
            {listing.owner_type && (
              <span className="list-card-source">
                <MapPin size={14} strokeWidth={2} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }} />
                {listing.owner_type === 'mulk_sahibi' ? 'Mülk Sahibi' : 'Emlak Ofisi'}
              </span>
            )}
          </div>
        </div>
        
        {visibleNotes.length > 0 && (
          <div className="list-card-notes-preview">
            {visibleNotes.length} not
          </div>
        )}
      </div>

      <div className="list-card-actions">
        <button 
          className="action-icon-btn"
          onClick={(e) => { e.stopPropagation(); onCall?.(listing) }}
          title="Ara"
        >
          <Phone size={18} strokeWidth={2} />
        </button>
        <button 
          className={`action-icon-btn ${listing.isOpportunity ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onOpportunity?.(listing) }}
          title="Fırsat"
        >
          <Star size={18} strokeWidth={2} />
        </button>
        <button 
          className="action-icon-btn"
          onClick={(e) => { e.stopPropagation(); onDetail?.(listing) }}
          title="Detay"
        >
          <Eye size={18} strokeWidth={2} />
        </button>
        <button 
          className="action-icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            const note = prompt('Not:', '')
            if (note != null && note.trim()) onNoteSave?.(listing.id, note.trim())
          }}
          title="Not"
        >
          <FileText size={18} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

export default ListingCard

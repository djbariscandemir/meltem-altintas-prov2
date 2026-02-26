import ListingCard from './ListingCard'
import EmptyState from '../EmptyState/EmptyState'
import './ListMode.css'

function ListMode({ user, listings, onOpportunity, onDetail, onCall, onNoteSave }) {
  if (listings.length === 0) {
    return <EmptyState type="listings" />
  }

  const getVisibleNotes = (listing) => {
    if (user.role === 'broker' || user.role === 'admin') {
      return listing.notes || []
    }
    return (listing.notes || []).filter(note => 
      !note.isPrivate || note.userId === user.id
    )
  }

  return (
    <div className="list-mode">
      {listings.map(listing => {
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
            onOpportunity={onOpportunity}
            onDetail={onDetail}
            onCall={onCall}
            onNoteSave={onNoteSave}
          />
        )
      })}
    </div>
  )
}

export default ListMode

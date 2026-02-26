import { useState } from 'react'
import { Clock, Phone } from 'lucide-react'
import AppLogo from '../AppLogo/AppLogo'
import Header from './Header'
import Navigation from './Navigation'
import ListingsView from '../Listings/ListingsView'
import AddListing from '../AddListing/AddListing'
import BuyerRequests from '../BuyerRequests/BuyerRequests'
import CustomStock from '../CustomStock/CustomStock'
import Tasks from '../Tasks/Tasks'
import TodayTasks from '../TodayTasks/TodayTasks'
import Notes from '../Notes/Notes'
import Profile from '../Profile/Profile'
import BrokerPanel from '../BrokerPanel/BrokerPanel'
import './Dashboard.css'

const getTodayTasksCount = (tasks, user) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const endOfDay = new Date(today)
  endOfDay.setHours(23, 59, 59, 999)
  const now = new Date()
  
  let filtered = tasks.filter(task => {
    const dueDate = new Date(task.dueDate)
    // Bugünkü görevler VEYA geçmiş tarihli hatırlatıcılar (henüz tamamlanmamış)
    const isToday = dueDate >= today && dueDate <= endOfDay
    const isOverdueReminder = task.isCustom && task.type === 'reminder' && dueDate < now && !task.isCalled
    return (isToday || isOverdueReminder) && !task.isCalled
  })

  if (user.role === 'user') {
    filtered = filtered.filter(task => 
      task.calledBy === null || task.calledBy === user.id
    )
  }

  return filtered.length
}

const VIEWS = {
  LISTINGS: 'listings',
  ADD_LISTING: 'add-listing',
  TODAY_TASKS: 'today-tasks',
  TASKS: 'tasks',
  NOTES: 'notes',
  BUYER_REQUESTS: 'buyer-requests',
  CUSTOM_STOCK: 'custom-stock',
  BROKER_PANEL: 'broker-panel',
  PROFILE: 'profile'
}

function Dashboard({ 
  user, 
  listings, 
  tasks, 
  buyerRequests, 
  notifications,
  onLogout,
  onProfileUpdate,
  onUpdateListings,
  onUpdateTasks,
  onUpdateBuyerRequests,
  onUpdateNotifications
}) {
  const [currentView, setCurrentView] = useState(VIEWS.LISTINGS)

  return (
    <div className="dashboard">
      <Header 
        user={user}
        notifications={notifications}
        onUpdateNotifications={onUpdateNotifications}
        onLogout={onLogout}
      />
      
      <Navigation 
        user={user}
        currentView={currentView}
        onViewChange={setCurrentView}
        unreadNotifications={notifications.filter(n => !n.isRead).length}
        todayTasksCount={getTodayTasksCount(tasks, user)}
      />
      
      {currentView === VIEWS.LISTINGS && (
        <div className="dashboard-welcome">
          <div className="welcome-content">
            <div className="welcome-logo-wrapper">
              <AppLogo imgClassName="welcome-logo" fallbackClassName="welcome-logo-fallback" />
            </div>
            <h2 className="welcome-title">Meltem Altıntaş Pro</h2>
            <p className="welcome-subtitle">Emlak yönetim sisteminize hoş geldiniz</p>
          </div>
        </div>
      )}
      
      {currentView === VIEWS.TODAY_TASKS && (
        <div className="dashboard-info-banner">
          <div className="info-banner-content">
            <Clock size={20} strokeWidth={2} />
            <div>
              <strong>Bugün Aranacaklar</strong>
              <p>Bugün yapılması gereken arama görevleriniz burada görünür. Tüm görevler için &quot;Görevler&quot; sayfasına bakın.</p>
            </div>
          </div>
        </div>
      )}
      
      {currentView === VIEWS.TASKS && (
        <div className="dashboard-info-banner">
          <div className="info-banner-content">
            <Phone size={20} strokeWidth={2} />
            <div>
              <strong>Arama Görevleri</strong>
              <p>Tüm arama görevlerinizi buradan görüntüleyebilir ve yönetebilirsiniz. Bekleyen, geciken ve tamamlanan görevleri filtreleyebilirsiniz.</p>
            </div>
          </div>
        </div>
      )}
      
      <main className="dashboard-main">
        {currentView === VIEWS.LISTINGS && (
          <ListingsView
            user={user}
            listings={listings}
            tasks={tasks}
            onUpdateListings={onUpdateListings}
            onUpdateTasks={onUpdateTasks}
          />
        )}

        {currentView === VIEWS.ADD_LISTING && (
          <AddListing
            user={user}
            onSuccess={() => onUpdateListings()}
            onUpdateListings={onUpdateListings}
          />
        )}

        {currentView === VIEWS.TODAY_TASKS && (
          <TodayTasks
            user={user}
            tasks={tasks}
            listings={listings}
            onUpdateTasks={onUpdateTasks}
            onUpdateListings={onUpdateListings}
          />
        )}

        {currentView === VIEWS.TASKS && (
          <Tasks
            user={user}
            tasks={tasks}
            listings={listings}
            onUpdateTasks={onUpdateTasks}
          />
        )}

        {currentView === VIEWS.NOTES && (
          <Notes
            user={user}
            listings={listings}
            onUpdateListings={onUpdateListings}
          />
        )}

        {currentView === VIEWS.BUYER_REQUESTS && (
          <BuyerRequests
            user={user}
            buyerRequests={buyerRequests}
            listings={listings}
            onUpdateBuyerRequests={onUpdateBuyerRequests}
          />
        )}

        {currentView === VIEWS.CUSTOM_STOCK && (
          <CustomStock
            user={user}
            listings={listings}
            onUpdateListings={onUpdateListings}
          />
        )}

        {currentView === VIEWS.BROKER_PANEL && (
          <BrokerPanel />
        )}

        {currentView === VIEWS.PROFILE && (
          <Profile user={user} onProfileUpdate={onProfileUpdate} />
        )}
      </main>
    </div>
  )
}

export default Dashboard

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  getMyProfile,
  resolveMapLink,
  updateMyProfile,
  changeMyPassword,
} from '../controllers/merchantProfileController.js'
import {
  getMyMenu,
  createCategory,
  updateCategory,
  deleteCategory,
  getItem,
  getItemImage,
  createItem,
  updateItem,
  deleteItem,
} from '../controllers/menuController.js'
import {
  listMyBanners,
  createBanner,
  updateBanner,
  reorderBanners,
  deleteBanner,
  getMyBannerImage,
} from '../controllers/bannersController.js'
import {
  readSplashBody,
  uploadMySplashMedia,
  deleteMySplashMedia,
  getMySplashMedia,
} from '../controllers/splashController.js'
import { getMyReviews } from '../controllers/reviewsController.js'
import { getMyOverview } from '../controllers/merchantOverviewController.js'
import { deleteMyOrder, getMyOrders, updateMyOrderStatus } from '../controllers/merchantOrdersController.js'
import {
  listMyNotifications,
  markMyNotificationRead,
  deleteMyNotification,
} from '../controllers/merchantNotificationsController.js'

/**
 * The authenticated merchant's own resources. Every route below is gated by
 * requireAuth, and the controllers derive merchantId from the token.
 */
const router = Router()
router.use(requireAuth)

// Profile
router.get('/profile', getMyProfile)
router.patch('/profile', updateMyProfile)
router.post('/profile/map-link/resolve', resolveMapLink)
router.post('/change-password', changeMyPassword)

// Menu
router.get('/menu', getMyMenu)
router.post('/menu/categories', createCategory)
router.patch('/menu/categories/:id', updateCategory)
router.delete('/menu/categories/:id', deleteCategory)
router.get('/menu/items/:id', getItem)
router.get('/menu/items/:id/image/:index', getItemImage)
router.post('/menu/items', createItem)
router.patch('/menu/items/:id', updateItem)
router.delete('/menu/items/:id', deleteItem)

// Storefront banners. /banners/order is declared before /banners/:id, which
// would otherwise capture "order" as an id.
router.get('/banners', listMyBanners)
router.post('/banners', createBanner)
router.patch('/banners/order', reorderBanners)
router.patch('/banners/:id', updateBanner)
router.delete('/banners/:id', deleteBanner)
router.get('/banners/:id/image', getMyBannerImage)

// Storefront welcome screen background. The switch and tagline save with the
// profile; the media is a raw upload of its own (see splashController).
router.get('/splash/media', getMySplashMedia)
router.put('/splash/media', readSplashBody, uploadMySplashMedia)
router.delete('/splash/media', deleteMySplashMedia)

// Orders (this merchant's own order history)
router.get('/orders', getMyOrders)
router.patch('/orders/:id', updateMyOrderStatus)
router.delete('/orders/:id', deleteMyOrder)

// Reviews
router.get('/reviews', getMyReviews)

// Dashboard stats
router.get('/overview', getMyOverview)

// Notifications (this merchant's own feed + read/dismiss state)
router.get('/notifications', listMyNotifications)
router.post('/notifications/:id/read', markMyNotificationRead)
router.delete('/notifications/:id', deleteMyNotification)

export default router

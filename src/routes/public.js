import { Router } from 'express'
import {
  getPublicConfig,
  getPublicRestaurant,
  getProductImages,
  getProductImage,
  getMerchantLogo,
  getBannerImage,
  getSplashMedia,
  createReview,
  createOrder,
} from '../controllers/publicController.js'

const router = Router()

router.get('/config', getPublicConfig)
router.get('/merchants/:merchantId', getPublicRestaurant)
router.get('/merchants/:merchantId/products/:productId/images', getProductImages)
// Image bytes, served individually so the browser can lazy-load and cache them.
router.get('/merchants/:merchantId/products/:productId/image/:index', getProductImage)
router.get('/merchants/:merchantId/logo', getMerchantLogo)
router.get('/merchants/:merchantId/banners/:bannerId/image', getBannerImage)
router.get('/merchants/:merchantId/splash', getSplashMedia)
router.post('/merchants/:merchantId/reviews', createReview)
router.post('/merchants/:merchantId/orders', createOrder)

export default router

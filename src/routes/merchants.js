import { Router } from 'express'
import {
  listMerchants,
  getMerchant,
  getMerchantProductImage,
  createMerchant,
  updateMerchant,
  deleteMerchant,
  resetMerchantPassword,
  impersonateMerchant,
  renewMerchant,
  cancelSubscription,
} from '../controllers/merchantsController.js'

const router = Router()

router.get('/', listMerchants)
router.get('/:id/products/:productId/image/:index', getMerchantProductImage)
router.get('/:id', getMerchant)
router.post('/', createMerchant)
router.post('/:id/reset-password', resetMerchantPassword)
router.post('/:id/impersonate', impersonateMerchant)
router.post('/:id/renew', renewMerchant)
router.post('/:id/cancel-subscription', cancelSubscription)
router.patch('/:id', updateMerchant)
router.delete('/:id', deleteMerchant)

export default router

import { Router } from 'express'
import { adminLogin, adminLogout } from '../controllers/adminAuthController.js'
import { authLimiter } from '../middleware/rateLimit.js'

const router = Router()

router.post('/login', authLimiter, adminLogin)
router.post('/logout', adminLogout)

export default router

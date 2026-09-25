import { Router } from 'express'
import { adminLogin, adminLogout } from '../controllers/adminAuthController.js'
import { loginLimiter } from '../middleware/rateLimit.js'

const router = Router()

router.post('/login', loginLimiter, adminLogin)
router.post('/logout', adminLogout)

export default router

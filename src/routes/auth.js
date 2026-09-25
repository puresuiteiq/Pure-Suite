import { Router } from 'express'
import {
  login,
  logout,
  forgotPassword,
  resetPassword,
  validateResetToken,
} from '../controllers/authController.js'
import { authLimiter, loginLimiter } from '../middleware/rateLimit.js'

const router = Router()

router.post('/login', loginLimiter, login)
router.post('/logout', logout)
router.post('/forgot-password', authLimiter, forgotPassword)
router.get('/reset-password/validate', validateResetToken)
router.post('/reset-password', authLimiter, resetPassword)

export default router

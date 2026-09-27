import { Router } from 'express'
import { requireSuperAdmin } from '../middleware/auth.js'
import {
  getAppearance,
  updateAppearance,
  changeAdminPassword,
  getMe,
} from '../controllers/adminProfileController.js'

const router = Router()

router.get('/me', getMe)
router.get('/appearance', getAppearance)
// Carries the storefront footer every merchant shows: the main admin's alone.
router.patch('/appearance', requireSuperAdmin, updateAppearance)
// Mounted behind requireAdmin in app.js — see the handler's note on why the
// router this lands on is security-critical.
router.post('/change-password', changeAdminPassword)

export default router

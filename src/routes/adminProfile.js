import { Router } from 'express'
import {
  getAppearance,
  updateAppearance,
  changeAdminPassword,
} from '../controllers/adminProfileController.js'

const router = Router()

router.get('/appearance', getAppearance)
router.patch('/appearance', updateAppearance)
// Mounted behind requireAdmin in app.js — see the handler's note on why the
// router this lands on is security-critical.
router.post('/change-password', changeAdminPassword)

export default router

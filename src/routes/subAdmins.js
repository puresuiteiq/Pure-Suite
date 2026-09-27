import { Router } from 'express'
import {
  listSubAdmins,
  createSubAdmin,
  resetSubAdminPassword,
  deleteSubAdmin,
} from '../controllers/subAdminsController.js'

/** Sub-admins — the main admin only (requireAdmin + requireSuperAdmin in app.js). */
const router = Router()

router.get('/', listSubAdmins)
router.post('/', createSubAdmin)
router.post('/:id/reset-password', resetSubAdminPassword)
router.delete('/:id', deleteSubAdmin)

export default router

import { Router } from 'express'
import { listNotifications, markNotificationRead, deleteNotification } from '../controllers/notificationsController.js'

const router = Router()

router.get('/', listNotifications)
router.post('/:id/read', markNotificationRead)
router.delete('/:id', deleteNotification)

export default router

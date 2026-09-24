import { Router } from 'express'
import { listOrders } from '../controllers/adminOrdersController.js'

const router = Router()

router.get('/', listOrders)

export default router

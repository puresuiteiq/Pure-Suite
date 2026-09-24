import { Router } from 'express'
import { getOverview, getRevenue } from '../controllers/overviewController.js'

const router = Router()

router.get('/', getOverview)
router.get('/revenue', getRevenue)

export default router

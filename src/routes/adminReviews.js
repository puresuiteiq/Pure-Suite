import { Router } from 'express'
import { listAllReviews, deleteReview } from '../controllers/adminReviewsController.js'

const router = Router()

router.get('/', listAllReviews)
router.delete('/:id', deleteReview)

export default router

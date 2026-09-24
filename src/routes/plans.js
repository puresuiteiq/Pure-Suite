import { Router } from 'express'
import {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
} from '../controllers/plansController.js'

const router = Router()

router.get('/', listPlans)
router.post('/', createPlan)
router.patch('/:id', updatePlan)
router.delete('/:id', deletePlan)

export default router

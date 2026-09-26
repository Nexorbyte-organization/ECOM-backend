import { Router } from 'express';
import { PaymentController } from '../controllers/payment.controller.js';
import { AuthMiddleware } from '../middlewares/authentication.js';
import { ErrorHandler } from '../utils/appError.js';

export const paymentRouter = Router();

paymentRouter.post('/paymob/webhook', ErrorHandler.asyncHandler(PaymentController.paymobWebhook));

paymentRouter.get(
  '/:settlementId',
  AuthMiddleware.isAuthenticated(),
  AuthMiddleware.isAuthorized(['admin', 'organizer', 'organizer_member', 'organizer_supervisor']),
  ErrorHandler.asyncHandler(PaymentController.getSettlement),
);

export default paymentRouter;

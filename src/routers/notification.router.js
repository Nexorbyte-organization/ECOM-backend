import { Router } from 'express';
import { AuthMiddleware } from '../middlewares/authentication.js';
import { ErrorHandler } from '../utils/appError.js';
import { NotificationController } from '../controllers/notification.controller.js';

export const notificationRouter = Router();
const auth = AuthMiddleware.isAuthenticated();

notificationRouter.get('/', auth, ErrorHandler.asyncHandler(NotificationController.list));
notificationRouter.patch('/read-all', auth, ErrorHandler.asyncHandler(NotificationController.markAllRead));
notificationRouter.patch('/:id/read', auth, ErrorHandler.asyncHandler(NotificationController.markRead));
notificationRouter.delete('/', auth, ErrorHandler.asyncHandler(NotificationController.clear));

export default notificationRouter;

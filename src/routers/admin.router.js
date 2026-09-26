import { Router } from 'express';
import { ErrorHandler } from '../utils/appError.js';
import { AuthMiddleware } from '../middlewares/authentication.js';
import { AdminController } from '../controllers/admin.controller.js';
import { ValidationMiddleware } from '../middlewares/validation.js';
import { EventActionRequestValidator, EventValidator } from '../validators/event.validator.js';
import { AdminUserValidator } from '../validators/user.validator.js';

export const adminRouter = Router();

const auth = [AuthMiddleware.isAuthenticated(), AuthMiddleware.isAuthorized(['admin'])];

// US-300: Dashboard
adminRouter.get('/dashboard', ...auth, ErrorHandler.asyncHandler(AdminController.getDashboard));

// US-301: All users (with ?search= and ?role= filters)
adminRouter.get('/users', ...auth, ErrorHandler.asyncHandler(AdminController.getAllUsers));

// US-309: Admin invite / create a user with a specific role
adminRouter.post('/users', ...auth, ValidationMiddleware.isValid(AdminUserValidator.invite), ErrorHandler.asyncHandler(AdminController.inviteUser));

// Scoped lists
adminRouter.get('/ushers', ...auth, ErrorHandler.asyncHandler(AdminController.getUshers));
adminRouter.get('/organizers', ...auth, ErrorHandler.asyncHandler(AdminController.getOrganizers));

// US-302: Block user
adminRouter.patch('/users/:id/block', ...auth, ErrorHandler.asyncHandler(AdminController.blockUser));

// US-303: Unblock user
adminRouter.patch('/users/:id/unblock', ...auth, ErrorHandler.asyncHandler(AdminController.unblockUser));

// US-304: Verify / Unverify user
adminRouter.patch('/users/:id/verify', ...auth, ErrorHandler.asyncHandler(AdminController.verifyUser));
adminRouter.patch('/users/:id/unverify', ...auth, ErrorHandler.asyncHandler(AdminController.unverifyUser));

// US-305: Reset late excuses
adminRouter.post('/ushers/:id/reset-excuses', ...auth, ErrorHandler.asyncHandler(AdminController.resetExcuses));

// Legacy: update user status
adminRouter.patch('/users/:id/status', ...auth, ErrorHandler.asyncHandler(AdminController.updateUserStatus));

// US-310: Delete user (and cascade their applications)
adminRouter.delete('/users/:id', ...auth, ErrorHandler.asyncHandler(AdminController.deleteUser));

// US-306: All events (with ?search= and ?status= filters)
adminRouter.get('/events', ...auth, ErrorHandler.asyncHandler(AdminController.getEvents));

// US-307: Change event status
adminRouter.patch('/events/:id/status', ...auth, ValidationMiddleware.isValid(EventValidator.updateStatus), ErrorHandler.asyncHandler(AdminController.updateEventStatus));

// US-308: Delete event (and its applications)
adminRouter.delete('/events/:id', ...auth, ErrorHandler.asyncHandler(AdminController.deleteEvent));

adminRouter.get('/event-action-requests', ...auth, ErrorHandler.asyncHandler(AdminController.getEventActionRequests));
adminRouter.patch('/event-action-requests/:id', ...auth, ValidationMiddleware.isValid(EventActionRequestValidator.resolve), ErrorHandler.asyncHandler(AdminController.resolveEventActionRequest));

export default adminRouter;

import { Router } from 'express';
import { ErrorHandler } from '../utils/appError.js';
import { AuthMiddleware } from '../middlewares/authentication.js';
import { UsherController } from '../controllers/usher.controller.js';
import { EventMapController } from '../controllers/event-map.controller.js';
import { MulterService } from '../utils/multer.cloud.js';
import { ValidationMiddleware } from '../middlewares/validation.js';
import { ApplicationValidator, AttendanceValidator, PaymentMethodValidator } from '../validators/event.validator.js';
import { UsherProfileValidator } from '../validators/user.validator.js';

export const usherRouter = Router();

const auth = [AuthMiddleware.isAuthenticated(), AuthMiddleware.isAuthorized(['usher'])];
const authShared = [AuthMiddleware.isAuthenticated(), AuthMiddleware.isAuthorized(['usher', 'admin', 'organizer', 'organizer_member', 'organizer_supervisor'])];
const upload = MulterService.cloudUpload();
const completeProfile = AuthMiddleware.requiresCompleteProfile();

// US-100-EXT: Dashboard stats
usherRouter.get('/dashboard', ...auth, ErrorHandler.asyncHandler(UsherController.getDashboard));

// US-101: Update own profile (text fields)
usherRouter.put('/profile/update', ...auth, ValidationMiddleware.isValid(UsherProfileValidator.update), ErrorHandler.asyncHandler(UsherController.updateProfile));

// US-102: Upload / change profile picture
usherRouter.patch('/profile/picture', ...auth, upload.single('picture'), ErrorHandler.asyncHandler(UsherController.uploadProfilePicture));
usherRouter.post('/profile/portfolio', ...auth, upload.single('image'), ErrorHandler.asyncHandler(UsherController.uploadPortfolioImage));
usherRouter.delete('/profile/portfolio/:index', ...auth, ErrorHandler.asyncHandler(UsherController.deletePortfolioImage));

// Payment methods
usherRouter.post('/profile/payment-methods', ...auth, ValidationMiddleware.isValid(PaymentMethodValidator.add), ErrorHandler.asyncHandler(UsherController.addPaymentMethod));
usherRouter.delete('/profile/payment-methods/:methodId', ...auth, ErrorHandler.asyncHandler(UsherController.deletePaymentMethod));
usherRouter.patch('/profile/payment-methods/:methodId/default', ...auth, ErrorHandler.asyncHandler(UsherController.setDefaultPaymentMethod));

// US-210: View any usher profile by id (shared: usher/admin/organizer)
usherRouter.get('/profile/:id', ...authShared, ErrorHandler.asyncHandler(UsherController.getUsherProfileById));
usherRouter.get('/profile/:id/reviews', ...authShared, ErrorHandler.asyncHandler(UsherController.getTalentReviews));

// US-103: Browse available events (with ?category= and ?city= filters)
usherRouter.get('/events/browse', ...auth, ErrorHandler.asyncHandler(UsherController.browseEvents));
usherRouter.get('/talents', ...auth, ErrorHandler.asyncHandler(UsherController.listTalents));

// US-104: Apply to an event (with schema validation)
usherRouter.post('/events/apply', ...auth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.apply), ErrorHandler.asyncHandler(UsherController.applyToEvent));

// US-105: Track applications (with ?filter=upcoming|past)
usherRouter.get('/applications/my', ...auth, ErrorHandler.asyncHandler(UsherController.getMyApplications));

// US-106: Get event history
usherRouter.get('/events/history', ...auth, ErrorHandler.asyncHandler(UsherController.getMyEventHistory));
usherRouter.get('/events/:id', ...auth, ErrorHandler.asyncHandler(UsherController.getEventById));
usherRouter.get('/events/:id/map', ...auth, ErrorHandler.asyncHandler(EventMapController.getUsherMap));

// Pay held because the usher was marked absent at a prefunded event, and disputes of that mark.

// Event-day check-in: scan the staff QR, type its 6-digit code, or "I'm here" by location.
usherRouter.post('/attendance/check-in', ...auth, ValidationMiddleware.isValid(AttendanceValidator.checkIn), ErrorHandler.asyncHandler(UsherController.checkIn));

// US-211: Accept or decline a direct booking invitation
usherRouter.patch('/applications/:applicationId/respond', ...auth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.respond), ErrorHandler.asyncHandler(UsherController.respondToBookingInvitation));

// Leave an event's standby list. Standby is unpaid, so leaving carries no penalty.
usherRouter.patch('/applications/:applicationId/leave-standby', ...auth, ErrorHandler.asyncHandler(UsherController.leaveStandby));

// US-107: Excuse from an accepted event
usherRouter.patch('/applications/:applicationId/excuse', ...auth, completeProfile, ErrorHandler.asyncHandler(UsherController.excuseFromEvent));

// US-109: Refer a talent to an event (with schema validation)
usherRouter.post('/refer', ...auth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.refer), ErrorHandler.asyncHandler(UsherController.referTalent));
usherRouter.post('/referral-invites', ...auth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.referralInvite), ErrorHandler.asyncHandler(UsherController.createReferralInvite));
usherRouter.post('/referral-invites/:token/redeem', ...auth, ErrorHandler.asyncHandler(UsherController.redeemReferralInvite));

// US-109-EXT: Manage incoming referrals
usherRouter.get('/referrals/pending', ...auth, ErrorHandler.asyncHandler(UsherController.getMyPendingReferrals));
usherRouter.patch('/referrals/:referralId/accept', ...auth, completeProfile, ErrorHandler.asyncHandler(UsherController.acceptReferral));
usherRouter.patch('/referrals/:referralId/decline', ...auth, completeProfile, ErrorHandler.asyncHandler(UsherController.declineReferral));

// US-100: Get own profile by id (must be after all /profile/* routes)
usherRouter.get('/:id', ...auth, ErrorHandler.asyncHandler(UsherController.getUsherProfile));

export default usherRouter;

import { Router } from 'express';
import { ErrorHandler } from '../utils/appError.js';
import { AuthMiddleware } from '../middlewares/authentication.js';
import { OrganizerController } from '../controllers/organizer.controller.js';
import { EventMapController } from '../controllers/event-map.controller.js';
import { StaffController } from '../controllers/staff.controller.js';
import { MulterService } from '../utils/multer.cloud.js';
import { ValidationMiddleware } from '../middlewares/validation.js';
import { EventValidator, ApplicationValidator, AttendanceValidator, ReviewValidator, StaffValidator, SupervisorValidator } from '../validators/event.validator.js';
import { OrganizerProfileValidator } from '../validators/user.validator.js';
import { PaymentController } from '../controllers/payment.controller.js';
import { FundingController } from '../controllers/funding.controller.js';
import { OrganizationTalentController } from '../controllers/organization-talent.controller.js';

export const organizerRouter = Router();

const ownerAuth = [AuthMiddleware.isAuthenticated(), AuthMiddleware.isAuthorized(['organizer'])];
const workspaceAuth = [
    AuthMiddleware.isAuthenticated(),
    AuthMiddleware.isAuthorized(['organizer', 'organizer_member', 'organizer_supervisor']),
];
const upload = MulterService.cloudUpload();
const completeProfile = AuthMiddleware.requiresCompleteProfile();

// US-201: Get own profile
organizerRouter.get('/profile', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getMyProfile));

// US-201: Update own profile (companyName, description, city, phone, website)
organizerRouter.put('/profile', ...ownerAuth, ValidationMiddleware.isValid(OrganizerProfileValidator.update), ErrorHandler.asyncHandler(OrganizerController.updateMyProfile));

// US-202: Upload company logo
organizerRouter.patch('/profile/logo', ...ownerAuth, upload.single('logo'), ErrorHandler.asyncHandler(OrganizerController.uploadLogo));

// US-200: Dashboard
organizerRouter.get('/dashboard', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getDashboard));

// US-203: Create event (with schema validation)
organizerRouter.post('/events', ...ownerAuth, completeProfile, ValidationMiddleware.isValid(EventValidator.create), ErrorHandler.asyncHandler(OrganizerController.createEvent));

// US-200: Get own events (with ?status= filter)
organizerRouter.get('/events', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getMyEvents));

// Get single event detail
organizerRouter.get('/events/:id', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getEventById));
organizerRouter.get('/events/:id/map', ...workspaceAuth, ErrorHandler.asyncHandler(EventMapController.getOrganizationMap));
organizerRouter.patch('/events/:id/map/image', ...ownerAuth, completeProfile, upload.single('map'), ErrorHandler.asyncHandler(EventMapController.uploadImage));
organizerRouter.post('/events/:id/map/pins', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(EventMapController.createPin));
organizerRouter.patch('/events/:id/map/pins/:pinId', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(EventMapController.updatePin));
organizerRouter.delete('/events/:id/map/pins/:pinId', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(EventMapController.deletePin));

// Check-in points: each staff phone shows a rotating QR and 6-digit code while it shares its location.
organizerRouter.get('/events/:id/check-in-points', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.listCheckInPoints));
organizerRouter.put('/events/:id/check-in-points/me', ...workspaceAuth, completeProfile, ValidationMiddleware.isValid(AttendanceValidator.openPoint), ErrorHandler.asyncHandler(OrganizerController.openCheckInPoint));
organizerRouter.delete('/events/:id/check-in-points/me', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.closeCheckInPoint));

// Update event
organizerRouter.put('/events/:id', ...ownerAuth, completeProfile, ValidationMiddleware.isValid(EventValidator.update), ErrorHandler.asyncHandler(OrganizerController.updateEvent));

// Upload or replace an event image after the event has been created.
organizerRouter.patch('/events/:id/photo', ...ownerAuth, completeProfile, upload.single('photo'), ErrorHandler.asyncHandler(OrganizerController.uploadEventPhoto));

// US-206: Close event (confirm)
organizerRouter.patch('/events/:id/close', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(OrganizerController.closeEvent));

// Mark an ended event completed so its ushers can be paid.
organizerRouter.patch('/events/:id/complete', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(OrganizerController.completeEvent));

// Assign / remove supervisor from event
organizerRouter.patch('/events/:id/supervisor', ...ownerAuth, completeProfile, ValidationMiddleware.isValid(SupervisorValidator.assign), ErrorHandler.asyncHandler(OrganizerController.assignSupervisor));

// US-205: View event applicants
organizerRouter.get('/events/:id/applicants', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getEventApplicants));

// US-205: Accept / reject applicant (with schema validation)
organizerRouter.patch('/applications/:applicationId/status', ...workspaceAuth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.updateStatus), ErrorHandler.asyncHandler(OrganizerController.updateApplicationStatus));

// US-207: Staff check-in for an usher whose phone cannot check in (present or late only)
organizerRouter.get('/events/:id/attendance', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getEventAttendance));
organizerRouter.post('/events/:id/attendance', ...workspaceAuth, completeProfile, ValidationMiddleware.isValid(AttendanceValidator.mark), ErrorHandler.asyncHandler(OrganizerController.markAttendance));

// US-208: Review & rate talent (with schema validation)
organizerRouter.get('/events/:id/reviews', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getEventReviews));
organizerRouter.post('/events/:id/reviews', ...workspaceAuth, completeProfile, ValidationMiddleware.isValid(ReviewValidator.create), ErrorHandler.asyncHandler(OrganizerController.reviewTalent));

// GET referrals for an event
organizerRouter.get('/events/:id/referrals', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.getEventReferrals));

// US-209: Search talent directory
organizerRouter.get('/talents', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizerController.searchTalents));
organizerRouter.get('/favorite-talents', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizationTalentController.listFavorites));
organizerRouter.put('/favorite-talents/:talentId', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizationTalentController.addFavorite));
organizerRouter.delete('/favorite-talents/:talentId', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizationTalentController.removeFavorite));
organizerRouter.get('/events/:id/last-team', ...workspaceAuth, ErrorHandler.asyncHandler(OrganizationTalentController.getLastTeam));
organizerRouter.post('/events/:id/rebook-last-team', ...workspaceAuth, completeProfile, ErrorHandler.asyncHandler(OrganizationTalentController.rebookLastTeam));

// US-211: Direct book a talent (with schema validation)
organizerRouter.post('/direct-book', ...workspaceAuth, completeProfile, ValidationMiddleware.isValid(ApplicationValidator.directBook), ErrorHandler.asyncHandler(OrganizerController.directBookTalent));

organizerRouter.post('/events/:id/whatsapp-group', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(OrganizerController.createWhatsAppGroup));

// Test-mode Paymob settlement for pay-after events: one collection for all eligible ushers after an event.
organizerRouter.get('/events/:id/settlement-preview', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.previewEventSettlement));
organizerRouter.get('/events/:id/settlement', ...workspaceAuth, ErrorHandler.asyncHandler(PaymentController.getEventSettlement));
organizerRouter.post('/events/:id/settlement', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.createEventSettlement));
organizerRouter.get('/events/:id/individual-settlements', ...workspaceAuth, ErrorHandler.asyncHandler(PaymentController.listIndividualSettlements));
organizerRouter.post('/events/:id/ushers/:talentId/settlement', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.createIndividualSettlement));
organizerRouter.patch('/settlements/:settlementId/lines/:lineId/cash-paid', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.markCashPaid));
organizerRouter.post('/settlements/:settlementId/lines/:lineId/retry-payout', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.retryIndividualPayout));
// Advance funding: the organization funds the hired team, and payments are released after the event.
organizerRouter.get('/events/:id/funding', ...workspaceAuth, ErrorHandler.asyncHandler(FundingController.getEventFunding));
organizerRouter.post('/events/:id/funding', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(FundingController.startEventFunding));
organizerRouter.patch('/events/:id/funding-mode', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(FundingController.setFundingMode));
organizerRouter.post('/events/:id/release-payments', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(FundingController.releaseEventFunds));
organizerRouter.get('/credit', ...ownerAuth, ErrorHandler.asyncHandler(FundingController.getCredit));
organizerRouter.get('/payment-cards', ...ownerAuth, ErrorHandler.asyncHandler(PaymentController.listOrganizerCards));
organizerRouter.post('/payment-cards/enrollments', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(PaymentController.startCardEnrollment));
organizerRouter.get('/payment-cards/enrollments/:enrollmentId', ...ownerAuth, ErrorHandler.asyncHandler(PaymentController.getCardEnrollment));
organizerRouter.patch('/payment-cards/:cardId/default', ...ownerAuth, ErrorHandler.asyncHandler(PaymentController.setDefaultOrganizerCard));
organizerRouter.delete('/payment-cards/:cardId', ...ownerAuth, ErrorHandler.asyncHandler(PaymentController.removeOrganizerCard));
organizerRouter.get('/payment-cards/:cardId/verify', ...ownerAuth, ErrorHandler.asyncHandler(PaymentController.verifyStoredCardToken));

// ── Staff Management ────────────────────────────────────────────────────────
organizerRouter.get('/staff', ...workspaceAuth, ErrorHandler.asyncHandler(StaffController.getStaffMembers));
organizerRouter.post('/staff', ...ownerAuth, completeProfile, ValidationMiddleware.isValid(StaffValidator.invite), ErrorHandler.asyncHandler(StaffController.inviteStaffMember));
organizerRouter.put('/staff/:id', ...ownerAuth, completeProfile, ValidationMiddleware.isValid(StaffValidator.update), ErrorHandler.asyncHandler(StaffController.updateStaffMember));
organizerRouter.patch('/staff/:id/block', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(StaffController.blockStaffMember));
organizerRouter.patch('/staff/:id/unblock', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(StaffController.unblockStaffMember));
organizerRouter.delete('/staff/:id', ...ownerAuth, completeProfile, ErrorHandler.asyncHandler(StaffController.removeStaffMember));

export default organizerRouter;

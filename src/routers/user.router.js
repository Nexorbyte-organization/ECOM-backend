import { Router } from "express";
import { ErrorHandler } from "../utils/appError.js";
import { UserController } from "../controllers/user.controller.js";
import { ValidationMiddleware } from "../middlewares/validation.js";
import { AuthMiddleware } from "../middlewares/authentication.js";
import { UserValidator } from "../validators/user.validator.js";
import { rateLimit } from 'express-rate-limit';

export const authRouter = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts. Please try again later.' },
});

// Public auth routes (with schema validation)
authRouter.post('/signup', authLimiter, ValidationMiddleware.isValid(UserValidator.signup), ErrorHandler.asyncHandler(UserController.signup));
authRouter.post('/login', authLimiter, ValidationMiddleware.isValid(UserValidator.login), ErrorHandler.asyncHandler(UserController.login));
authRouter.post('/resend-verification', authLimiter, ValidationMiddleware.isValid(UserValidator.forgetPassword), ErrorHandler.asyncHandler(UserController.resendVerification));
authRouter.post('/forget-password', authLimiter, ValidationMiddleware.isValid(UserValidator.forgetPassword), ErrorHandler.asyncHandler(UserController.forgetPassword));
authRouter.post('/verify-otp', authLimiter, ValidationMiddleware.isValid(UserValidator.verifyOtp), ErrorHandler.asyncHandler(UserController.verifyOtp));
authRouter.post('/reset-password', authLimiter, ValidationMiddleware.isValid(UserValidator.resetPassword), ErrorHandler.asyncHandler(UserController.resetPassword));
authRouter.post('/refresh', authLimiter, ErrorHandler.asyncHandler(UserController.refreshSession));
authRouter.post('/logout', ErrorHandler.asyncHandler(UserController.logout));
authRouter.get('/referral-invites/:token', ErrorHandler.asyncHandler(UserController.getReferralInvite));

// Get own profile — any authenticated user can call this to get their own data
authRouter.get('/me', AuthMiddleware.isAuthenticated(), ErrorHandler.asyncHandler(UserController.getMyProfile));

// Get all users — restricted to ushers (as originally intended)
authRouter.get('/users', AuthMiddleware.isAuthenticated(), AuthMiddleware.isAuthorized(['usher']), ErrorHandler.asyncHandler(UserController.getAllUsers));

export default authRouter;

import joi from 'joi';
import { AppError } from '../utils/appError.js';

export const generalFields = {
  name: joi.string(),
  email: joi.string().email(),
  password: joi.string().min(8).max(128).required(),
  rePassword: joi.string().valid(joi.ref('password')),
  id: joi.number().integer().positive(),
  comment: joi.string(),
};

export class ValidationMiddleware {
  static isValid(schema) {
    return (req, res, next) => {
      const data = {
        ...req.body,
        ...req.params,
        ...req.query,
      };
      const { error } = schema.validate(data, {
        abortEarly: false,   // collect ALL field errors, not just the first
        stripUnknown: true,  // ignore extra fields without error
      });
      if (error) {
        // Clean Joi's quoted field names: "fullName" is required → fullName is required
        const messages = error.details.map((d) => d.message.replace(/['"]/g, ''));
        return next(new AppError(messages.length === 1 ? messages[0] : messages, 400));
      }
      next();
    };
  }

  static async isAdmin(req, res, next) {
    try {
      if (!req.authUser || req.authUser.role !== 'admin') {
        return next(new AppError('Unauthorized - Admin access required', 403));
      }
      next();
    } catch (error) {
      return next(new AppError('Authentication failed', 401));
    }
  }
}

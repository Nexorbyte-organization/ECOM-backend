import { FileService } from './file-function.js';
import { UniqueConstraintError, ValidationError } from 'sequelize';

export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class ErrorHandler {
  static asyncHandler(fn) {
    return (req, res, next) => {
      fn(req, res, next).catch((err) => {
        // Pass Sequelize errors through unwrapped so the global handler can
        // identify them by instanceof and return field-specific messages.
        if (err instanceof UniqueConstraintError || err instanceof ValidationError) {
          return next(err);
        }
        const appError = new AppError(err.message, err.statusCode || 500);
        appError.publicMessage = err.publicMessage;
        return next(appError);
      });
    };
  }

  static globalErrorHandler(err, req, res, next) {
    if (req.file?.path) {
      FileService.deleteFile(req.file.path);
    }

    if (err?.name === 'MulterError') {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : err.message,
      });
    }

    // ── Sequelize: duplicate unique field (email, mobileNumber, userName) ──
    if (err instanceof UniqueConstraintError) {
      const fieldMessages = {
        email: 'This email address is already registered.',
        mobileNumber: 'This mobile number is already in use.',
        userName: 'This username is already taken.',
      };

      const violated = err.errors?.[0]?.path;
      const message = fieldMessages[violated] || `'${violated}' already exists.`;

      return res.status(409).json({
        success: false,
        message,
        field: violated,
      });
    }

    // ── Sequelize: model-level validation failure ──────────────────────────
    if (err instanceof ValidationError) {
      const messages = err.errors.map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.length === 1 ? messages[0] : messages,
      });
    }

    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'error',
        requestId: req.headers['x-request-id'],
        method: req.method,
        path: req.originalUrl,
        message: err.message,
        stack: process.env.APP_ENV === 'prod' ? undefined : err.stack,
      }));
    }
    return res.status(statusCode).json({
      message: statusCode >= 500 && process.env.APP_ENV === 'prod'
        ? err.publicMessage || 'Internal server error'
        : err.message,
      success: false,
    });
  }
}

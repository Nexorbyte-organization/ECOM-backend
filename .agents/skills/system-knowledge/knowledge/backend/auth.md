# Authentication and sessions

## Current behavior
Signup sends a purpose-bound email-verification link handled by GET /verify/:token. Login requires valid credentials, email verification, and an unblocked account. Email verification is separate from talent performance verification.

Login and refresh issue access/refresh JWTs in HTTP-only oo_access/oo_refresh cookies (15 minutes/30 days; SameSite=Lax; Secure in production). User stores a SHA-256 refresh-token hash and expiry; refresh rotates the session. Logout clears cookies and refresh state; password reset invalidates refresh state.

Access extraction prefers Authorization (Bearer or raw), then legacy token header, then the cookie. Browser clients use cookies; this is not bearer-only authentication.

Forgot-password → OTP validation (three failed attempts) → purpose-bound reset token → reset-password. Auth endpoints are rate limited.

## Source entry points
- `src/routers/user.router.js`
- `src/controllers/user.controller.js`
- `src/utils/token.js`
- `src/utils/session.js`
- `src/middlewares/authentication.js`
- `src/initapp.js`
- `db/models/user.model.js`
- `src/validators/user.validator.js`

## Change coupling
Session changes affect the frontend request adapter and auth provider.

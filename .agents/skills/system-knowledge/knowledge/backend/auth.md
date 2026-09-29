# Authentication and sessions

## Current behavior
Signup sends a purpose-bound email-verification link handled by GET /verify/:token. Login requires valid credentials, email verification, and an unblocked account. Email verification is separate from talent performance verification.

Login and refresh issue access/refresh JWTs in HTTP-only oo_access/oo_refresh cookies (15 minutes/30 days; SameSite=Lax; Secure in production). User stores a SHA-256 refresh-token hash and expiry. Access JWTs carry a sessionHash checked against that stored hash on every authenticated request. Each successful login replaces the session for all roles: other devices receive 401 on their next authenticated request or refresh. Requests already authenticated may finish; there is no push notification or physical device tracking.

Refresh rotates both tokens using an atomic comparison against the presented refresh token's hash, so an obsolete refresh cannot replace a newer login or revive a logged-out/reset session. Rotation also invalidates earlier access tokens from the same browser. Logout clears cookies and only clears server state if the presented refresh token still matches; an older device cannot log out the current session. Password reset invalidates both access and refresh tokens by clearing refresh state. No schema migration is needed. Legacy access tokens without sessionHash are rejected after deployment; a valid existing refresh token can obtain a bound token pair.

Access extraction prefers Authorization (Bearer or raw), then legacy token header, then the cookie. Browser clients use cookies; this is not bearer-only authentication.

Forgot-password → OTP validation (three failed attempts) → purpose-bound reset token → reset-password. Auth endpoints are rate limited.

Soft-deleted users are excluded from normal account lookups, so login, refresh, verification, password recovery, and authenticated requests cannot use them. Organization cascades also delete staff accounts. Existing requests that passed authentication before deletion may still finish. Signup duplicate checks include archived records because email, username, and mobile uniqueness remain global.

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
Clients must replace access tokens after refresh, coordinate concurrent refresh attempts, and return to sign-in when refresh receives 401. Terminated devices discover logout on their next request; immediate UI logout requires frontend polling or a separate push mechanism.

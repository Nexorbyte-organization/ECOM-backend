# Profiles, completion, and talent discovery

## Current behavior
User holds usher and organization data. Organizer companyName/location/description map to fullName/city/organizationInfo. Staff profile reads resolve the owner.

Usher completion requires full name, uploaded profile image, city, mobile number, education, work cities, languages, event categories, and a payment method. Organizer completion requires company name, uploaded logo, description, location, and phone. Blank/N/A text and default_avatar do not satisfy backend completion.

Profile/photo/logo endpoints allow completing an incomplete profile. Ushers also manage portfolio images and payout methods/default selection. Categories/languages are normalized. Directories exclude blocked/incomplete ushers and use public projections. Signup never accepts rating, profile image, or portfolio values; ratings come only from reviews and images only from uploads. `src/utils/publicTalent.js` owns user projections: `publicTalent` removes contact details (including the serializer's `phoneNumber` alias), payout accounts, and credential/session fields; `talentForOrganization` keeps applicant contact details but masks payout numbers to the last four digits. The usher profile endpoint returns only usher accounts: admins see the full record without secrets, organization workspaces see masked payout accounts, and ushers see the public projection. `GET /auth/users` returns public usher projections only. Raw payout destinations are read only by settlement code.

Organizations share a favorite usher list across their owner and staff. The `organization_favorites` table has at most one active row per organization/usher pair; removal soft deletes it. `GET /organizer/favorite-talents` returns only currently unblocked, complete usher public profiles; `PUT` and `DELETE /organizer/favorite-talents/:talentId` add/remove a favorite. Adding an unavailable usher fails; repeated add/remove is safe. Favorites do not reserve or book an usher.

New Cloudinary uploads use `ECOM/ushers/{userId}/profile-picture`, `ECOM/ushers/{userId}/portfolio`, and `ECOM/organization/{userId}/logo`. IDs come from the authenticated user's loaded record. Folders are centralized in `src/utils/uploadFolders.js` and created on upload. Existing images are not moved; stored URLs/public IDs and replacement/deletion behavior remain compatible. No frontend API change is required.

## Source entry points
- `src/utils/profileCompletion.js`
- `src/utils/publicTalent.js`
- `src/utils/talentVisibility.js`
- `src/utils/normalization.js`
- `src/controllers/usher.controller.js`
- `src/controllers/organizer.controller.js`
- `src/validators/user.validator.js`
- `db/models/user.model.js`
- `db/models/organization-favorite.model.js`
- `src/controllers/organization-talent.controller.js`
- `src/utils/multer.cloud.js`
- `src/utils/cloudinary.js`
- `src/utils/uploadFolders.js`

## Change coupling
Completion/projection changes affect frontend normalization, forms, and gates. Payout interpretation belongs in payments.md. Relevant checks: test/publicTalent.test.js and test/talentVisibility.test.js.

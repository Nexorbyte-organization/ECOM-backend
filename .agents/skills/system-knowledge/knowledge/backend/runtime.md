# Runtime, database, and API boundary

## Current behavior
Node ES modules, Express 5, Sequelize/PostgreSQL. index.js sets security/CORS/server entry; src/initapp.js validates configuration, connects DB, mounts routes/docs/health/errors. db/connection.js initializes models; db/migrate.js upgrades existing PostgreSQL schema.

Aliases /usher and /talent share a router; /organizer and /provider share a router. Other prefixes: /auth, /admin, /notifications, /payments. /health reports server/database state; /docs/openapi.json exposes generated OpenAPI.

Core configuration requires PG_URI and JWT_SECRET_KEY (at least 32 characters). Production validates base/frontend URL, email, and Cloudinary presence. Describe configuration names without values. Payments validate configuration separately.

Startup connects/migrates DB; do not run it as a documentation-only check. npm test and npm run lint verify relevant code changes. Contract changes may require npm run generate:openapi and generated-doc review.

## Source entry points
- `index.js`
- `src/initapp.js`
- `src/index.js`
- `db/connection.js`
- `db/migrate.js`
- `db/index.js`
- `package.json`
- `docs/generate-docs.js`
- `test/backend-alignment.test.js`

## Change coupling
The frontend is a separate Git repository; no sibling directory or personal configuration is required for this skill.

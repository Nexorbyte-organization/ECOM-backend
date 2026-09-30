// Sequelize's alter mode can drop and recreate existing foreign keys during startup.
// Permit it only when a developer explicitly opts in on a local development database.
export const shouldAlterSchema = (env = process.env) => (
  env.DB_SYNC_ALTER === 'true'
  && env.APP_ENV === 'dev'
  && env.NODE_ENV !== 'production'
  && !env.VERCEL
);
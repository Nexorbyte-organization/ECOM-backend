import { sequelize } from './connection.js';

const runStatements = async (statements) => {
  for (const statement of statements) {
    await sequelize.query(statement);
  }
};

export const migrateExistingSchema = async () => {
  if (sequelize.getDialect() !== 'postgres') return;

  const [tables] = await sequelize.query(`
    SELECT
      to_regclass('public.users') IS NOT NULL AS "hasUsers",
      to_regclass('public.events') IS NOT NULL AS "hasEvents"
  `);
  const state = tables[0] || {};

  if (state.hasUsers) {
    const [roleTypes] = await sequelize.query(`
      SELECT 1 FROM pg_type WHERE typname = 'enum_users_role' LIMIT 1
    `);
    if (roleTypes.length) {
      await runStatements([
        `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'organizer_member'`,
        `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'organizer_supervisor'`,
      ]);
    }

    await runStatements([
      `ALTER TABLE "users" ALTER COLUMN "mobileNumber" DROP NOT NULL`,
      `ALTER TABLE "users" ALTER COLUMN "city" DROP NOT NULL`,
      `UPDATE "users" SET "experience" = 0 WHERE "experience" IS NULL`,
      `ALTER TABLE "users" ALTER COLUMN "experience" SET DEFAULT 0`,
      `ALTER TABLE "users" ALTER COLUMN "experience" SET NOT NULL`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "workCities" VARCHAR(255)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(255)[]`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "education" TEXT`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsappNumber" VARCHAR(255)`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsappConsentGiven" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsappConsentGivenAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refreshTokenHash" VARCHAR(255)`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" TIMESTAMP WITH TIME ZONE`,
    ]);
  }

  if (state.hasEvents) {
    await runStatements([
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "gatheringLocation" VARCHAR(255)`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "photo" JSONB`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "mapImage" JSONB`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "mapPins" JSONB NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "specifyGenders" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "malesCount" INTEGER`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "femalesCount" INTEGER`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "supervisorIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[]`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "whatsappGroupId" VARCHAR(255)`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "whatsappGroupLink" VARCHAR(255)`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "attendanceQrCreatedAt" TIMESTAMP WITH TIME ZONE`,
    ]);
  }

  const [settlementTables] = await sequelize.query(`
    SELECT to_regclass('public.event_settlements') IS NOT NULL AS "hasSettlements"
  `);
  if (settlementTables[0]?.hasSettlements) {
    await runStatements([
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "selectedCardId" UUID`,
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "targetTalentId" UUID REFERENCES "users"("id")`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT c.conname FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'event_settlements' AND c.contype = 'u'
             AND pg_get_constraintdef(c.oid) = 'UNIQUE ("eventId")'
         LOOP EXECUTE format('ALTER TABLE "event_settlements" DROP CONSTRAINT %I', item.conname); END LOOP;
       END $$`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT i.relname AS index_name FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid
           WHERE t.relname = 'event_settlements' AND x.indisunique AND x.indnatts = 1
             AND x.indpred IS NULL AND pg_get_indexdef(x.indexrelid) LIKE '%("eventId")%'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
         LOOP EXECUTE format('DROP INDEX IF EXISTS %I', item.index_name); END LOOP;
       END $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "event_settlements_bulk_event_unique"
         ON "event_settlements" ("eventId") WHERE "targetTalentId" IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "event_settlements_individual_unique"
         ON "event_settlements" ("eventId", "targetTalentId") WHERE "targetTalentId" IS NOT NULL`,
    ]);
  }
  const [lineTables] = await sequelize.query(`
    SELECT to_regclass('public.settlement_lines') IS NOT NULL AS "hasLines"
  `);
  if (lineTables[0]?.hasLines) {
    await runStatements([
      `ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "payoutRetrySafe" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "payoutAttempt" INTEGER NOT NULL DEFAULT 0`,
    ]);
  }
};

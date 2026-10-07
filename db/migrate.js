import { sequelize } from './connection.js';

const runStatements = async (statements) => {
  for (const statement of statements) {
    await sequelize.query(statement);
  }
};

// Creates a Sequelize-named enum type for a column added to an existing table.
const createEnumType = (name, values) => `DO $$ BEGIN
    CREATE TYPE "${name}" AS ENUM (${values.map((value) => `'${value}'`).join(', ')});
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`;

export const migrateExistingSchema = async () => {
  if (sequelize.getDialect() !== 'postgres') return;

  // Models are registered before migration. Existing rows remain active (NULL).
  const queryGenerator = sequelize.getQueryInterface().queryGenerator;
  for (const model of Object.values(sequelize.models)) {
    if (!model.options.paranoid) continue;
    const table = queryGenerator.quoteTable(model.getTableName());
    await sequelize.query(`ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE`);
  }

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
      createEnumType('enum_users_paymentTierOverride', ['standard', 'trusted']),
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paymentTierOverride" "enum_users_paymentTierOverride"`,
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspendedUntil" TIMESTAMP WITH TIME ZONE`,
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
      // Events created before advance funding keep the post-event checkout they were created with.
      createEnumType('enum_events_fundingMode', ['prefund', 'pay_after']),
      `ALTER TYPE "enum_events_fundingMode" ADD VALUE IF NOT EXISTS 'preauth'`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "fundingCardId" UUID`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "holdReminders" JSONB NOT NULL DEFAULT '{}'::jsonb`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "fundingMode" "enum_events_fundingMode" NOT NULL DEFAULT 'pay_after'`,
      `ALTER TABLE "events" ALTER COLUMN "fundingMode" SET DEFAULT 'prefund'`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "fundsReleasedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venueLatitude" DOUBLE PRECISION`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venueLongitude" DOUBLE PRECISION`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "noShowFeeCents" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "standbyCount" INTEGER NOT NULL DEFAULT 0`,
      // Multi-day events. Existing events run on eventDate only.
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "days" JSONB NOT NULL DEFAULT '[]'::jsonb`,
      `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP WITH TIME ZONE`,
      `UPDATE "events" SET "endDate" = "eventDate" WHERE "endDate" IS NULL`,
    ]);
  }

  const [applicationTables] = await sequelize.query(`
    SELECT to_regclass('public.applications') IS NOT NULL AS "hasApplications"
  `);
  if (applicationTables[0]?.hasApplications) {
    await runStatements([
      ...['standby', 'withdrawn'].map((value) => `ALTER TYPE "enum_applications_status" ADD VALUE IF NOT EXISTS '${value}'`),
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "standbyOk" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "standbyInvite" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "standbySince" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "promotedAt" TIMESTAMP WITH TIME ZONE`,
    ]);
  }

  const [attendanceTables] = await sequelize.query(`
    SELECT to_regclass('public.attendances') IS NOT NULL AS "hasAttendance"
  `);
  if (attendanceTables[0]?.hasAttendance) {
    await runStatements([
      createEnumType('enum_attendances_checkInMethod', ['qr', 'manual', 'admin']),
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "checkInMethod" "enum_attendances_checkInMethod" NOT NULL DEFAULT 'manual'`,
      ...['code', 'location', 'staff', 'auto'].map((value) => `ALTER TYPE "enum_attendances_checkInMethod" ADD VALUE IF NOT EXISTS '${value}'`),
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "checkInLatitude" DOUBLE PRECISION`,
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "checkInLongitude" DOUBLE PRECISION`,
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "checkInPointId" UUID`,
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "recordedBy" UUID`,
      // Attendance is recorded per event day; existing records belong to the first day.
      `ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "dayIndex" INTEGER NOT NULL DEFAULT 0`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT c.conname FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'attendances' AND c.contype = 'u'
             AND pg_get_constraintdef(c.oid) = 'UNIQUE ("eventId", "talentId")'
         LOOP EXECUTE format('ALTER TABLE "attendances" DROP CONSTRAINT %I', item.conname); END LOOP;
       END $$`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT i.relname AS index_name FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid
           WHERE t.relname = 'attendances' AND x.indisunique AND x.indnatts = 2
             AND x.indpred IS NULL AND pg_get_indexdef(x.indexrelid) LIKE '%("eventId", "talentId")%'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
         LOOP EXECUTE format('DROP INDEX IF EXISTS %I', item.index_name); END LOOP;
       END $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "attendances_event_talent_day_unique"
         ON "attendances" ("eventId", "talentId", "dayIndex")`,
    ]);
  }

  const [creditTypes] = await sequelize.query(`
    SELECT 1 FROM pg_type WHERE typname = 'enum_organizer_credit_entries_type' LIMIT 1
  `);
  if (creditTypes.length) {
    await runStatements(['no_show_refund', 'card_refund_failed'].map((value) => (
      `ALTER TYPE "enum_organizer_credit_entries_type" ADD VALUE IF NOT EXISTS '${value}'`
    )));
  }

  const [settlementTables] = await sequelize.query(`
    SELECT to_regclass('public.event_settlements') IS NOT NULL AS "hasSettlements"
  `);
  if (settlementTables[0]?.hasSettlements) {
    await runStatements([
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "selectedCardId" UUID`,
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "targetTalentId" UUID REFERENCES "users"("id")`,
      createEnumType('enum_event_settlements_fundingSource', ['checkout', 'prefund']),
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "fundingSource" "enum_event_settlements_fundingSource" NOT NULL DEFAULT 'checkout'`,
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
      // Card-hold events settle one day at a time, so uniqueness is per event day (-1 = no day).
      `ALTER TABLE "event_settlements" ADD COLUMN IF NOT EXISTS "dayIndex" INTEGER NOT NULL DEFAULT -1`,
      // Rebuild each unique index only while it still has its old, day-less definition.
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'event_settlements_bulk_event_unique' AND indexdef NOT LIKE '%dayIndex%') THEN
           DROP INDEX "event_settlements_bulk_event_unique";
         END IF;
         IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'event_settlements_individual_unique' AND indexdef NOT LIKE '%dayIndex%') THEN
           DROP INDEX "event_settlements_individual_unique";
         END IF;
       END $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "event_settlements_bulk_event_unique"
         ON "event_settlements" ("eventId", "dayIndex") WHERE "targetTalentId" IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "event_settlements_individual_unique"
         ON "event_settlements" ("eventId", "targetTalentId", "dayIndex") WHERE "targetTalentId" IS NOT NULL`,
    ]);
  }
  const [fundingTables] = await sequelize.query(`
    SELECT to_regclass('public.event_fundings') IS NOT NULL AS "hasFundings"
  `);
  if (fundingTables[0]?.hasFundings) {
    await runStatements([
      createEnumType('enum_event_fundings_kind', ['advance', 'fee', 'day_hold']),
      `ALTER TABLE "event_fundings" ADD COLUMN IF NOT EXISTS "kind" "enum_event_fundings_kind" NOT NULL DEFAULT 'advance'`,
      `ALTER TABLE "event_fundings" ADD COLUMN IF NOT EXISTS "dayIndex" INTEGER NOT NULL DEFAULT -1`,
      `ALTER TABLE "event_fundings" ADD COLUMN IF NOT EXISTS "capturedCents" INTEGER`,
      `ALTER TABLE "event_fundings" ADD COLUMN IF NOT EXISTS "closeReason" VARCHAR(255)`,
      `ALTER TYPE "enum_event_fundings_collectionStatus" ADD VALUE IF NOT EXISTS 'authorized'`,
      `ALTER TYPE "enum_event_fundings_collectionStatus" ADD VALUE IF NOT EXISTS 'voided'`,
      `ALTER TYPE "enum_event_fundings_collectionStatus" ADD VALUE IF NOT EXISTS 'closing'`,
      // One checkout in progress per event, fee or day, so two clicks cannot charge twice.
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'event_fundings_active_checkout_unique' AND indexdef NOT LIKE '%dayIndex%') THEN
           DROP INDEX "event_fundings_active_checkout_unique";
         END IF;
       END $$`,
    ]);
  }
  const [lineTables] = await sequelize.query(`
    SELECT to_regclass('public.settlement_lines') IS NOT NULL AS "hasLines"
  `);
  if (lineTables[0]?.hasLines) {
    await runStatements([
      `ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "payoutRetrySafe" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "payoutAttempt" INTEGER NOT NULL DEFAULT 0`,
      createEnumType('enum_settlement_lines_lineType', ['attendance', 'cancellation_compensation', 'dispute_award']),
      `ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "lineType" "enum_settlement_lines_lineType" NOT NULL DEFAULT 'attendance'`,
      `ALTER TABLE "settlement_lines" ALTER COLUMN "attendanceStatus" DROP NOT NULL`,
      `ALTER TYPE "enum_settlement_lines_payoutStatus" ADD VALUE IF NOT EXISTS 'awaiting_method'`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT c.conname FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'settlement_lines' AND c.contype = 'u'
             AND pg_get_constraintdef(c.oid) = 'UNIQUE ("settlementId", "talentId")'
         LOOP EXECUTE format('ALTER TABLE "settlement_lines" DROP CONSTRAINT %I', item.conname); END LOOP;
       END $$`,
      `DO $$ DECLARE item RECORD; BEGIN
         FOR item IN SELECT i.relname AS index_name FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid
           WHERE t.relname = 'settlement_lines' AND x.indisunique AND x.indnatts = 2
             AND x.indpred IS NULL AND pg_get_indexdef(x.indexrelid) LIKE '%("settlementId", "talentId")%'
             AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
         LOOP EXECUTE format('DROP INDEX IF EXISTS %I', item.index_name); END LOOP;
       END $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "settlement_lines_active_talent_unique"
         ON "settlement_lines" ("settlementId", "talentId") WHERE "deletedAt" IS NULL`,
    ]);
  }
};

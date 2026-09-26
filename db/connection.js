import { Sequelize } from 'sequelize';
import pg from 'pg'; // Explicit import so Vercel's bundler includes it
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('./.env') });
void pg;

export const sequelize = new Sequelize(process.env.PG_URI, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: process.env.PG_SSL === 'true' ? { require: true, rejectUnauthorized: false } : false,
    },
});

export const connectDB = async () => {
    try {
        // Import models to register them with sequelize (needed for sync)
        await import('../db/index.js');

        await sequelize.authenticate();
        const { migrateExistingSchema } = await import('./migrate.js');
        await migrateExistingSchema();
        await sequelize.sync({
            alter: process.env.APP_ENV === 'dev', // auto-alter schema in dev; disable in prod
        });
        // eslint-disable-next-line no-console
        console.log('\x1b[32m✔ PostgreSQL connected & synced successfully\x1b[0m');
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('\x1b[31m✖ DB connection error:\x1b[0m', error);
        throw error;
    }
};

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { initApp } from './src/initapp.js';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

dotenv.config();
const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const deployedOrigins = ['https://ecom-frontend-ruddy-theta.vercel.app'];
const developmentOrigins = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'prod';
const allowedOrigins = isProduction
  ? [...configuredOrigins, ...deployedOrigins]
  : [...configuredOrigins, ...deployedOrigins, ...developmentOrigins];

app.set('trust proxy', 1);
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
}));

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from a 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Add route handler for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'welcome.html'));
});

// Initialize the app (DB connection, routes, etc.)
const readyPromise = initApp(app, express);

// In dev, start the Express server, DB connection happens in parallel
if (!isProduction) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`\x1b[36m🚀 Server is running on port ${port}\x1b[0m`);
  });
}

// For Vercel: @vercel/node calls the default export as a plain Node.js (req, res) handler.
// We await readyPromise so DB is connected and all routes are registered before any request is handled.
const handler = async (req, res) => {
  await readyPromise;
  app(req, res);
};

export default handler;

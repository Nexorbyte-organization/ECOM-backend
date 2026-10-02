import dotenv from 'dotenv';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { connectDB, sequelize } from '../db/connection.js';
import { TokenService } from './utils/token.js';
import { HtmlTemplateService } from './utils/htmlTemplate.js';
import { AppError, ErrorHandler } from './utils/appError.js';
// Routes will be imported here as they are created
import * as allRouters from './index.js'
import { User } from '../db/models/user.model.js';
import { seedDemoData } from '../scripts/seed-demo-data.js';
import { EventAutomationService } from './services/event-automation.service.js';
import { timingSafeEqual } from 'crypto';

dotenv.config({ path: path.resolve('./.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const initApp = async (app, express) => {
  const required = ['PG_URI', 'JWT_SECRET_KEY'];
  const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'prod';
  if (isProduction) {
    required.push(
      'BASE_URL', 'FRONTEND_URL', 'EMAIL_USER', 'EMAIL_PASS',
      'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
    );
  }
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if ((process.env.JWT_SECRET_KEY || '').length < 32) throw new Error('JWT_SECRET_KEY must contain at least 32 characters');

  app.use(express.static('public'));
  app.use(express.json());
  await connectDB();

  // Health check endpoint — live DB status
  app.get('/health', async (req, res) => {
    try {
      await sequelize.authenticate();
      return res.status(200).json({ server: true, database: true });
    } catch {
      return res.status(200).json({ server: true, database: false });
    }
  });

  // Scheduled sweep for time-based event steps (funding deadline, missed check-ins, automatic
  // payment release). The same steps also run when events are read. Vercel Cron sends
  // CRON_SECRET as a bearer token; without the variable the endpoint is disabled.
  app.get('/internal/cron/event-automation', async (req, res, next) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) return next(new AppError('Event automation cron is not configured', 403));
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return next(new AppError('Invalid cron secret', 401));
    try {
      const result = await EventAutomationService.sweep({});
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/seed/demo', async (req, res, next) => {
    const expectedSecret = process.env.DEMO_SEED_SECRET;
    const providedSecret = req.get('x-seed-secret') || req.query.secret;

    if (!expectedSecret) {
      return next(new AppError('Demo seeding is not configured for this environment', 403));
    }

    if (providedSecret !== expectedSecret) {
      return next(new AppError('Invalid demo seed secret', 401));
    }

    const result = await seedDemoData();
    return res.status(200).json({
      success: true,
      message: 'Admin account seeded successfully',
      data: result,
    });
  });

  // Helper to load OpenAPI spec from multiple possible paths (local vs Vercel serverless)
  const getOpenApiSpec = () => {
    const pathsToTry = [
      path.resolve(__dirname, '../docs/openapi.json'),
      path.resolve(process.cwd(), 'docs/openapi.json'),
      path.resolve(process.cwd(), 'O-Ushers/docs/openapi.json'),
    ];
    for (const p of pathsToTry) {
      try {
        const fileContent = readFileSync(p, 'utf8');
        if (fileContent) return JSON.parse(fileContent);
      } catch {
        // try next path
      }
    }
    return null;
  };

  // OpenAPI spec endpoint — returns raw JSON spec for APIdog / Postman / Swagger UI
  // GET /docs/openapi.json
  app.get('/docs/openapi.json', (req, res) => {
    const spec = getOpenApiSpec();
    if (spec) {
      return res.status(200).json(spec);
    }
    return res.status(404).json({ success: false, message: 'OpenAPI spec not found. Run: npm run generate:openapi' });
  });

  // Interactive Swagger UI HTML template with sleek Dark Mode theme (works 100% on Vercel production)
  const renderSwaggerHtml = (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>O-Ushers API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-main: #0b0f19;
      --bg-card: #111827;
      --bg-subtle: #1f2937;
      --border-color: #374151;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --accent-cyan: #06b6d4;
    }

    html, body {
      margin: 0;
      padding: 0;
      background-color: var(--bg-main) !important;
      color: var(--text-main) !important;
      font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
    }

    .swagger-ui {
      color: var(--text-main) !important;
      font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
    }

    .swagger-ui .topbar { display: none !important; }

    .swagger-ui .info {
      margin: 24px 0 !important;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .swagger-ui .info .title {
      color: var(--text-main) !important;
      font-size: 2rem !important;
      font-weight: 700 !important;
      letter-spacing: -0.025em;
    }

    .swagger-ui .info p, .swagger-ui .info li, .swagger-ui .info td {
      color: var(--text-muted) !important;
    }

    .swagger-ui .scheme-container {
      background: var(--bg-card) !important;
      border: 1px solid var(--border-color) !important;
      border-radius: 12px;
      box-shadow: none !important;
      padding: 16px 24px !important;
    }

    .swagger-ui .opblock-tag {
      color: var(--text-main) !important;
      border-bottom: 1px solid var(--border-color) !important;
      font-weight: 600 !important;
      font-size: 1.25rem !important;
      padding: 12px 0 !important;
    }

    .swagger-ui .opblock {
      background: var(--bg-card) !important;
      border: 1px solid var(--border-color) !important;
      border-radius: 10px !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2) !important;
      margin-bottom: 16px !important;
    }

    .swagger-ui .opblock .opblock-summary {
      border-bottom: 1px solid transparent !important;
    }

    .swagger-ui .opblock .opblock-summary-method {
      border-radius: 6px !important;
      font-weight: 700 !important;
      min-width: 80px !important;
      text-align: center !important;
      text-shadow: none !important;
    }

    /* HTTP Methods Styling */
    .swagger-ui .opblock-get { border-color: #0284c7 !important; background: rgba(2, 132, 199, 0.12) !important; }
    .swagger-ui .opblock-get .opblock-summary-method { background: #0284c7 !important; color: #fff !important; }
    .swagger-ui .opblock-get .opblock-summary-path { color: #38bdf8 !important; font-weight: 600; }

    .swagger-ui .opblock-post { border-color: #059669 !important; background: rgba(5, 150, 105, 0.12) !important; }
    .swagger-ui .opblock-post .opblock-summary-method { background: #059669 !important; color: #fff !important; }
    .swagger-ui .opblock-post .opblock-summary-path { color: #34d399 !important; font-weight: 600; }

    .swagger-ui .opblock-put { border-color: #d97706 !important; background: rgba(217, 119, 6, 0.12) !important; }
    .swagger-ui .opblock-put .opblock-summary-method { background: #d97706 !important; color: #fff !important; }
    .swagger-ui .opblock-put .opblock-summary-path { color: #fbbf24 !important; font-weight: 600; }

    .swagger-ui .opblock-patch { border-color: #7c3aed !important; background: rgba(124, 58, 237, 0.12) !important; }
    .swagger-ui .opblock-patch .opblock-summary-method { background: #7c3aed !important; color: #fff !important; }
    .swagger-ui .opblock-patch .opblock-summary-path { color: #c084fc !important; font-weight: 600; }

    .swagger-ui .opblock-delete { border-color: #dc2626 !important; background: rgba(220, 38, 38, 0.12) !important; }
    .swagger-ui .opblock-delete .opblock-summary-method { background: #dc2626 !important; color: #fff !important; }
    .swagger-ui .opblock-delete .opblock-summary-path { color: #f87171 !important; font-weight: 600; }

    .swagger-ui .opblock .opblock-summary-description {
      color: var(--text-muted) !important;
    }

    .swagger-ui .opblock-body {
      background: var(--bg-subtle) !important;
      color: var(--text-main) !important;
    }

    .swagger-ui label, .swagger-ui .tab li, .swagger-ui .response-col_status, .swagger-ui .response-col_links, .swagger-ui .parameter__name, .swagger-ui .parameter__type {
      color: var(--text-main) !important;
    }

    .swagger-ui table thead tr th, .swagger-ui table thead tr td {
      color: var(--text-main) !important;
      border-bottom: 1px solid var(--border-color) !important;
    }

    .swagger-ui table tbody tr td {
      color: var(--text-muted) !important;
    }

    .swagger-ui input[type=text], .swagger-ui textarea, .swagger-ui select {
      background: var(--bg-main) !important;
      color: var(--text-main) !important;
      border: 1px solid var(--border-color) !important;
      border-radius: 6px !important;
      padding: 8px 12px !important;
    }

    .swagger-ui input[type=text]:focus, .swagger-ui textarea:focus, .swagger-ui select:focus {
      border-color: var(--accent-cyan) !important;
      outline: none !important;
    }

    .swagger-ui .btn {
      border-radius: 6px !important;
      font-weight: 600 !important;
      border: 1px solid var(--border-color) !important;
      color: var(--text-main) !important;
      background: var(--bg-subtle) !important;
    }

    .swagger-ui .btn.authorize {
      background: #0284c7 !important;
      color: #fff !important;
      border-color: #0284c7 !important;
    }

    .swagger-ui .btn.execute {
      background: #059669 !important;
      color: #fff !important;
      border-color: #059669 !important;
    }

    .swagger-ui section.models {
      border: 1px solid var(--border-color) !important;
      border-radius: 12px !important;
      background: var(--bg-card) !important;
    }

    .swagger-ui section.models h4 {
      color: var(--text-main) !important;
      border-bottom: 1px solid var(--border-color) !important;
    }

    .swagger-ui .model-box {
      background: var(--bg-main) !important;
      color: var(--text-main) !important;
    }

    .swagger-ui .highlight-code pre {
      background: #030712 !important;
      color: #f3f4f6 !important;
      border-radius: 8px !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .microlight {
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .auth-container input[type=text], .swagger-ui .auth-container input[type=password] {
      background: var(--bg-main) !important;
      color: var(--text-main) !important;
    }

    .swagger-ui .dialog-ux .modal-ux {
      background: var(--bg-card) !important;
      border: 1px solid var(--border-color) !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5) !important;
      color: var(--text-main) !important;
    }

    .swagger-ui .dialog-ux .modal-ux-header h3 {
      color: var(--text-main) !important;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: "/docs/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`);
  };

  // Interactive Swagger UI documentation endpoints (Vercel + Local)
  app.get('/docs', renderSwaggerHtml);
  app.get('/docs/', renderSwaggerHtml);
  app.get('/api-docs', renderSwaggerHtml);
  app.get('/api-docs/', renderSwaggerHtml);
  app.get('/swagger', renderSwaggerHtml);
  app.get('/swagger/', renderSwaggerHtml);

  app.get('/verify/:token', async (req, res) => {
    try {
      const payload = TokenService.verifyPurposeToken({ token: req.params.token, purpose: 'email_verification' });

      await User.update({ isEmailVerified: true }, { where: { email: payload.email } });

      // Send the HTML verification success page
      res.status(200).send(HtmlTemplateService.verificationSuccess());
    } catch (err) {
      // Send the HTML verification failed page
      res.status(401).send(HtmlTemplateService.verificationFailed());
    }
  });

  app.use('/auth', allRouters.authRouter);
  app.use('/usher', allRouters.usherRouter);
  app.use('/talent', allRouters.usherRouter);
  app.use('/organizer', allRouters.organizerRouter);
  app.use('/provider', allRouters.organizerRouter);
  app.use('/admin', allRouters.adminRouter);
  app.use('/notifications', allRouters.notificationRouter);
  app.use('/payments', allRouters.paymentRouter);
  app.use(ErrorHandler.globalErrorHandler);
};

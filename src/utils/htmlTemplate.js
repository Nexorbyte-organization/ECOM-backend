const BRAND = {
  navy: '#0F172A',
  orange: '#F97316',
  orangeDark: '#C2570C',
  canvas: '#F8FAFC',
  border: '#E2E8F0',
  muted: '#64748B',
};

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const appUrl = () => (process.env.FRONTEND_URL || 'https://usher-swart.vercel.app').replace(/\/$/, '');
const apiUrl = () => (process.env.BASE_URL || 'https://o-ushers.vercel.app').replace(/\/$/, '');

function brandLockup() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td width="42" height="42" align="center" valign="middle" style="width:42px;height:42px;border-radius:14px;background:#FFF7ED;border:1px solid #FED7AA;font-family:Arial,sans-serif;font-size:17px;font-weight:900;letter-spacing:-3px;color:${BRAND.navy};line-height:42px;">O<span style="color:${BRAND.orange};">O</span></td>
      <td style="padding-left:12px;font-family:Arial,'Segoe UI',sans-serif;">
        <div style="font-size:15px;font-weight:900;letter-spacing:-.4px;line-height:18px;color:${BRAND.navy};">OO<span style="color:${BRAND.orange};">—</span>USHERS</div>
        <div style="padding-top:2px;font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;line-height:11px;color:${BRAND.muted};">People make the moment</div>
      </td>
    </tr>
  </table>`;
}

function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" bgcolor="${BRAND.orange}" style="border-radius:10px;">
      <a href="${href}" target="_blank" style="display:inline-block;padding:14px 22px;border-radius:10px;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;font-weight:700;line-height:20px;color:#FFFFFF;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;
}

function emailLayout({ preheader, eyebrow, title, body, action, footer }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <title>${title} | OO-Ushers</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${BRAND.canvas};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
        <tr><td style="padding:0 8px 22px;">${brandLockup()}</td></tr>
        <tr><td style="background:#FFFFFF;border:1px solid ${BRAND.border};border-radius:18px;overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="height:5px;background:${BRAND.orange};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:34px 32px 12px;font-family:Arial,'Segoe UI',sans-serif;">
              <div style="font-size:11px;font-weight:800;letter-spacing:1.4px;line-height:16px;text-transform:uppercase;color:${BRAND.orange};">${eyebrow}</div>
              <h1 style="margin:10px 0 0;font-size:28px;font-weight:800;letter-spacing:-.7px;line-height:34px;color:${BRAND.navy};">${title}</h1>
            </td></tr>
            <tr><td style="padding:14px 32px 8px;font-family:Arial,'Segoe UI',sans-serif;font-size:16px;line-height:25px;color:#475569;">${body}</td></tr>
            ${action ? `<tr><td style="padding:20px 32px 34px;">${action}</td></tr>` : ''}
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 18px 0;font-family:Arial,'Segoe UI',sans-serif;font-size:12px;line-height:18px;color:${BRAND.muted};">${footer || 'OO-Ushers · People make the moment'}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export class HtmlTemplateService {
  static emailConfirmation(token) {
    const verificationUrl = `${apiUrl()}/verify/${encodeURIComponent(token)}`;
    return emailLayout({
      preheader: 'Confirm your email to activate your OO-Ushers account.',
      eyebrow: 'Account setup',
      title: 'Confirm your email',
      body: '<p style="margin:0;">Welcome to OO-Ushers. Confirm your email address to activate your account and start finding the right event opportunities.</p><p style="margin:16px 0 0;">This link is for you only. If you did not create an account, you can safely ignore this email.</p>',
      action: button('Confirm email address', verificationUrl),
      footer: 'Need help? Reply to this email and the OO-Ushers team will help.',
    });
  }

  static otpEmail(otp) {
    const safeOtp = escapeHtml(otp);
    return emailLayout({
      preheader: `${safeOtp} is your OO-Ushers password reset code.`,
      eyebrow: 'Password reset',
      title: 'Your security code',
      body: `<p style="margin:0;">Use this code to reset your password. It expires in <strong style="color:${BRAND.navy};">15 minutes</strong>.</p>
        <div style="margin:24px 0 0;padding:18px 20px;border:1px solid #FED7AA;border-radius:12px;background:#FFF7ED;text-align:center;font-size:30px;font-weight:800;letter-spacing:8px;line-height:36px;color:${BRAND.navy};">${safeOtp}</div>
        <p style="margin:20px 0 0;font-size:14px;line-height:22px;color:${BRAND.muted};">Didn’t request a password reset? You can safely ignore this email.</p>`,
      footer: 'OO-Ushers will never ask you to share this code.',
    });
  }

  static customerSupport({ name, email, phoneNumber, message }) {
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phoneNumber || 'Not provided');
    const safeMessage = escapeHtml(message).replace(/\r?\n/g, '<br>');
    return emailLayout({
      preheader: `New support message from ${safeName}.`,
      eyebrow: 'Support inbox',
      title: 'New contact message',
      body: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;font-size:14px;line-height:21px;">
        <tr><td style="padding:12px 14px;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};width:90px;">Name</td><td style="padding:12px 14px;border-bottom:1px solid ${BRAND.border};font-weight:700;color:${BRAND.navy};">${safeName}</td></tr>
        <tr><td style="padding:12px 14px;border-bottom:1px solid ${BRAND.border};color:${BRAND.muted};">Email</td><td style="padding:12px 14px;border-bottom:1px solid ${BRAND.border};"><a href="mailto:${safeEmail}" style="color:${BRAND.orangeDark};font-weight:700;text-decoration:none;">${safeEmail}</a></td></tr>
        <tr><td style="padding:12px 14px;color:${BRAND.muted};">Phone</td><td style="padding:12px 14px;color:${BRAND.navy};">${safePhone}</td></tr>
      </table>
      <div style="margin:20px 0 0;font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND.muted};">Message</div>
      <div style="margin:8px 0 0;padding:16px;border-radius:12px;background:${BRAND.canvas};color:${BRAND.navy};">${safeMessage}</div>`,
      action: button('Reply to sender', `mailto:${encodeURIComponent(email)}`),
      footer: 'This automated notification was sent from the OO-Ushers contact form.',
    });
  }

  static verificationSuccess() {
    return emailLayout({
      preheader: 'Your OO-Ushers email has been confirmed.',
      eyebrow: 'Email confirmed',
      title: 'You’re all set',
      body: '<p style="margin:0;">Your email address has been confirmed and your account is ready to use.</p>',
      action: button('Go to login', `${appUrl()}/login`),
    });
  }

  static verificationFailed() {
    return emailLayout({
      preheader: 'This email verification link is no longer valid.',
      eyebrow: 'Verification needed',
      title: 'This link isn’t valid',
      body: '<p style="margin:0;">The verification link may have expired or was already used. Return to login and request another email if you still need to confirm your account.</p>',
      action: button('Go to login', `${appUrl()}/login`),
    });
  }
}

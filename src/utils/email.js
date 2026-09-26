import nodemailer from 'nodemailer';

export class EmailService {
  static async sendEmail({ to = '', subject = '', html = '' }) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Oo-Ushers" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
  }
}

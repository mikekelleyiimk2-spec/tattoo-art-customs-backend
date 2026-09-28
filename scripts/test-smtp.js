// One-off: verify SMTP actually sends in production.
// Run in the Render shell AFTER the SMTP_* env vars are set:
//   node scripts/test-smtp.js
// Sends a test message to ADMIN_EMAIL and prints the result.
const config = require('../src/config');
const { sendMail } = require('../src/lib/mail');

async function main() {
  console.log('smtp host=' + (config.smtp.host || '(unset)') + ' port=' + config.smtp.port);
  console.log('smtp user=' + (config.smtp.user ? config.smtp.user.slice(0, 3) + '***' : '(unset)'));
  console.log('smtp from=' + config.smtp.from);
  console.log('admin email=' + (config.adminEmail || '(unset)'));
  if (!config.smtpConfigured()) {
    console.log('RESULT: FAIL — SMTP not configured (host/user/pass missing)');
    process.exit(1);
  }
  if (!config.adminEmail) {
    console.log('RESULT: FAIL — ADMIN_EMAIL not set');
    process.exit(1);
  }
  try {
    const info = await sendMail({
      to: config.adminEmail,
      subject: 'Tattoo Art Customs SMTP test',
      text: 'This is a test message from the Tattoo Art Customs production server. If you received this, SMTP is working.',
    });
    console.log('RESULT: OK — message accepted' + (info && info.messageId ? ' id=' + info.messageId : ''));
  } catch (err) {
    console.log('RESULT: FAIL — ' + err.message);
    process.exit(1);
  }
  process.exit(0);
}

main();

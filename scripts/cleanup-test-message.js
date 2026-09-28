// One-off cleanup: delete the QA test conversation "Question for Adolfo"
// created by the dry-run account during messaging verification.
// Usage (Render shell): node scripts/cleanup-test-message.js <conversationId>
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');

async function main() {
  const convId = process.argv[2];
  if (!convId) { console.error('usage: node scripts/cleanup-test-message.js <conversationId>'); process.exit(2); }
  await migrate();
  const conv = await db.get('SELECT id, subject FROM conversations WHERE id = ?', [convId]);
  if (!conv) { console.log('CLEANUP_NOOP: conversation not found'); process.exit(0); }
  await db.run('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  await db.run('DELETE FROM conversation_participants WHERE conversation_id = ?', [convId]);
  await db.run('DELETE FROM conversations WHERE id = ?', [convId]);
  console.log('CLEANUP_OK: deleted conversation', JSON.stringify(conv.subject));
  process.exit(0);
}
main().catch((e) => { console.error('CLEANUP_FAIL', e.message); process.exit(1); });

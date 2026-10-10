// Opening-raffle welcome email template.
// Copy approved VERBATIM by the owner on 2026-10-09 — do not change a word
// of the subject or body. Sent once per new raffle entrant at signup
// (see routes/auth.js); the send is idempotent because enterRaffleOnSignup
// only reports entered:true for a genuinely new entry.
const RAFFLE_WELCOME_SUBJECT = "You're in the raffle 🎉 — welcome to Tattoo Art Customs";
const RAFFLE_WELCOME_TEXT = "Hey — Mike here. You're officially entered in our opening raffle — free entry, no purchase, winners drawn at random. Good luck.\n\nWhile you wait: the gallery has 900+ original designs, each delivered with full color + clean linework: https://tattoo-art-customs.onrender.com/gallery\n\nAnd if you've got an idea of your own — members get 20% off their first custom design during the opening sale (membership starts at $5.67/mo): https://tattoo-art-customs.onrender.com/membership\n\nGlad to have you here,\nMike";

async function sendRaffleWelcomeEmail(to) {
  const { sendMail } = require("./mail");
  await sendMail({ to, subject: RAFFLE_WELCOME_SUBJECT, text: RAFFLE_WELCOME_TEXT });
}

module.exports = { RAFFLE_WELCOME_SUBJECT, RAFFLE_WELCOME_TEXT, sendRaffleWelcomeEmail };

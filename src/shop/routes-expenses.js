// Shop expense tracker routes (mounted at /shop/expenses by the coordinator).
const express = require('express');
const { requireLogin, requireSubscription } = require('../middleware/auth');
const { formLimiter, checkHoneypot } = require('../middleware/rateLimit');
const {
  EXPENSE_CATEGORIES,
  addExpense, getExpenses, deleteExpense, getMonthlyTotals, getCategoryTotals,
  monthKey, monthStartUtc,
} = require('./expenses');

const router = express.Router();
const gate = [requireLogin, requireSubscription('tattoo_shop')];

// Dashboard: selected month's expenses + monthly totals + category breakdown.
router.get('/', ...gate, async (req, res) => {
  const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : monthKey(Date.now());
  const [year, mon] = month.split('-').map(Number);
  const from = Date.UTC(year, mon - 1, 1);
  const to = Date.UTC(year, mon, 1);
  const expenses = await getExpenses(req.user.id, from, to);
  const monthlyTotals = await getMonthlyTotals(req.user.id, 12);
  const categoryTotals = await getCategoryTotals(req.user.id, from, to);
  const monthTotal = expenses.reduce((acc, e) => acc + e.amount_cents, 0);
  res.render('shop/expenses/list', {
    title: 'Expenses — Tattoo Art Customs',
    expenses, monthlyTotals, categoryTotals, monthTotal, month,
    categories: EXPENSE_CATEGORIES,
  });
});

// Log an expense (amount entered in dollars).
router.post('/', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    const dollars = parseFloat(req.body.amount_dollars);
    if (!Number.isFinite(dollars) || dollars <= 0) throw new Error('Enter a valid dollar amount.');
    let spentAt = null;
    if (req.body.spent_on) {
      const d = new Date(`${req.body.spent_on}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) spentAt = d.getTime();
    }
    await addExpense({
      shopUserId: req.user.id,
      amountCents: Math.round(dollars * 100),
      category: req.body.category,
      description: req.body.description,
      spentAt,
    });
    req.session.flash = 'Expense logged.';
  } catch (e) {
    req.session.flash = e.message;
  }
  const month = req.body.month || monthKey(Date.now());
  res.redirect(`/shop/expenses?month=${month}`);
});

// Delete an expense.
router.post('/:id/delete', ...gate, formLimiter, checkHoneypot, async (req, res) => {
  try {
    await deleteExpense({ shopUserId: req.user.id, id: req.params.id });
    req.session.flash = 'Expense deleted.';
  } catch (e) {
    req.session.flash = e.message;
  }
  res.redirect(`/shop/expenses?month=${req.body.month || monthKey(Date.now())}`);
});

module.exports = router;

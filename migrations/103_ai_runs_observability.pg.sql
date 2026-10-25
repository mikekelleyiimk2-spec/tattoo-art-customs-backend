-- 103: OneMind API-lane observability (owner order 2026-10-25)
-- ai_runs gains the per-hop provider gauges the lane was missing
-- finish_reason keeps the provider's own stop reason for the hop
-- (Gemini STOP or MAX_TOKENS, chat-completions stop or length,
-- Anthropic end_turn or max_tokens) and provider_detail keeps a
-- faithful extract of the hop as JSON (finish reason, truncation
-- flag, the full extracted text, and the measured token counts)
-- Before this, a truncated answer was indistinguishable from a
-- complete one in the record, and the 2026-10-25 table briefing
-- filed a 130-character Gemini fragment as a finished answer with
-- no retained evidence of what the provider actually sent
ALTER TABLE ai_runs ADD COLUMN finish_reason TEXT;
ALTER TABLE ai_runs ADD COLUMN provider_detail TEXT;

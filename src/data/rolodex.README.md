# src/data/rolodex.json — served copy, NOT the source

This file is a verbatim copy of the Affiliate Rolodex data core. The
**canonical source** is `~/workspace/app/affiliate-rolodex/rolodex.json`
(the Slice 1 project — see its `README.md` for the schema and `PLUG.md`
for the plug contract).

Refresh this copy from the canonical source when programs change; do not
hand-edit it here. It is served live by `GET /api/rolodex`
(`src/lib/rolodex.js` + `src/routes/api.js`) and feeds the affiliate
entries in `GET /api/app-links`.

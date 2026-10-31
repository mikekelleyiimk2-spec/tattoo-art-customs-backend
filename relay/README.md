# brambleforce-relay

The Brambleforce online co-op relay (design:
`~/workspace/your_files/brambleforce-online-coop-design-2026-10-31.md` §2).
A dedicated, always-on WebSocket service — its own Render Starter
($7/mo, owner-approved 2026-10-31) so co-op sessions never share a
fate with the store backend's deploys.

It pairs two game clients and forwards bytes; the host's game is the
authority. Pairing modes:

- **Player pool** (`room: "POOL"` in the hello): FIFO, first waiter
  hosts, pairs only equal game builds. Seat-only — the hello's
  `seatToken` is validated against the store backend before pairing.
- **Room codes**: a host opens a code, a guest joins by code. Guests
  may join a code room without a seat (host vouches; they ride as
  "Player 2" with base skins). A presented seat token must validate.

## Run

```
npm install
npm start            # binds $PORT (Render) or 8791 locally
npm run proof        # local end-to-end proof battery (test/proof.js)
```

## Env

| Var | Meaning |
|---|---|
| `PORT` | Listen port (Render injects this). Local default 8791. |
| `RELAY_SEAT_CHECK_URL` | Full URL of the backend seat check, e.g. `https://tattoo-art-customs.onrender.com/api/onemind/seat`. The relay calls it with header `x-api-token: <seatToken>`; 200 + `{ok:true}` = valid seat. **When unset, the player pool is CLOSED (code-join only) and the relay logs it loudly — a validation that cannot run is never faked as a pass.** |
| `RELAY_SEAT_CHECK_TIMEOUT_MS` | Seat-check timeout (default 3000). Timeout/error = check unavailable, never a pass. |
| `RELAY_DEAD_PEER_MS` | Silence before a peer is declared dead (default 3000, the design's §5.1 rule). |
| `RELAY_HELLO_TIMEOUT_MS` | Time a socket may sit connected without a hello (default 10000). |

## Health

`GET /health` → `{ ok, service, version, uptime_s, rooms, poolWaiting,
seatCheck: "configured" | "disabled-code-join-only", stats, now }`.
This is the Render health-check path.

## Protocol (v1)

Client → relay: `hello {room, role, build, fighter, skins, name,
seatToken}` · `input {seq, v}` (guest→host) · `snap {...}` (host→guest,
stored as the room's last snapshot) · `ping`/`pong` · `session {...}`
(session chatter, forwarded) · `quit`.

Relay → client: `paired {room, role, build, partner}` · `pool-waiting`
· `peer-left {reason}` · `error {code, ...}` — codes: `bad-hello`,
`pool-closed`, `seat-required`, `seat-invalid`,
`seat-check-unavailable`, `version-mismatch {yourBuild, roomBuild}`,
`room-full`, `server-closing`.

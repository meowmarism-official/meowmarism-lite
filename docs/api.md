# HTTP API

An optional REST API for scripts, bots and dashboards. It is part of the panel and **off by default**.

Switch it on under **Update → Optional features → HTTP API**. There you also create tokens and webhooks. Switching it off makes `/api/v1` answer 404 again; tokens and webhooks are kept.

The API lives on the panel port under `/api/v1`. Every request needs a token:

```
curl -H "Authorization: Bearer mmk_…" https://panel.example.com/api/v1/instances
```

Use HTTPS when the panel is reachable from the internet; a token is a password.

## Tokens

A token is shown once when it is created and only its hash is stored. Each token has

- **scopes**, what it may do (below),
- optionally a list of **instances** it may touch (empty = all); other instances answer `404`,
- optionally an **expiry**.

| Scope | Allows |
|---|---|
| `read` | status, players, metrics, diagnostics, settings |
| `power` | start, stop, restart, force-stop |
| `console` | read the console, send commands, say, tell, player actions, start a profile |
| `settings` | change settings (restart-only settings are queued until the next start) |
| `backups` | list and create backups |
| `files` | list and read files of an instance |
| `events` | event stream and webhooks |
| `database` | read and change databases (see Databases below) |

Limits: 300 requests per minute per token; 20 failed logins per five minutes per address (`429`).

## Responses

JSON. Errors look like `{ "ok": false, "error": "…" }` with `401` (no or bad token), `403` (missing scope), `404` (unknown endpoint or instance), `409` (the instance panel is not running), `429`, `502` (the instance panel did not answer).

## Endpoints

`:name` is the instance name.

### Overview
| | | Scope |
|---|---|---|
| `GET /api/v1` | version, your scopes | any |
| `GET /api/v1/instances` | all instances with phase, TPS, players | `read` |
| `GET /api/v1/instances/:name` | one instance | `read` |
| `GET /api/v1/instances/:name/players` | online players | `read` |
| `GET /api/v1/instances/:name/metrics` | TPS, MSPT, tick times, lag, CPU, RAM, heap and GC | `read` |
| `GET /api/v1/instances/:name/diagnostics` | tick timing, lag warnings, JVM, profile state | `read` |

An instance is `{ name, loader, mcVersion, port, panel: "on" | "off", running, phase, tps, mspt, players, … }`. `phase` is `offline`, `starting`, `ready` or `stopping`.

### Control
| | Body | Scope |
|---|---|---|
| `POST /api/v1/instances/:name/start` | | `power` |
| `POST /api/v1/instances/:name/stop` | | `power` |
| `POST /api/v1/instances/:name/restart` | | `power` |
| `POST /api/v1/instances/:name/force-stop` | | `power` |

### In-game commands
| | Body | Scope |
|---|---|---|
| `POST /api/v1/instances/:name/command` | `{ "cmd": "time set day" }` | `console` |
| `POST /api/v1/instances/:name/say` | `{ "message": "Restart in 5 minutes" }` | `console` |
| `POST /api/v1/instances/:name/players/:player/message` | `{ "message": "hi" }` (runs `tell`) | `console` |
| `POST /api/v1/instances/:name/players/:player/action` | `{ "action": "kick", "reason": "AFK" }` | `console` |
| `GET /api/v1/instances/:name/console?lines=200` | last console lines (max 1000) | `console` |

`command` takes one command on one line; a leading `/` is removed. Player actions: `kick`, `ban`, `pardon`, `op`, `deop`, `whitelist-add`, `whitelist-remove`, `kill`, `heal`, `feed`, `clear-effects` and `gamemode` (with `"value": "survival" | "creative" | "adventure" | "spectator"`). They also work for players that are offline.

### Settings, backups, files
| | Scope |
|---|---|
| `GET /api/v1/instances/:name/settings` | `read` |
| `POST /api/v1/instances/:name/settings` with `{ "settings": { "max-players": 40 } }` | `settings` |
| `GET /api/v1/instances/:name/backups` | `backups` |
| `POST /api/v1/instances/:name/backups` (starts a backup, `202`) | `backups` |
| `GET /api/v1/instances/:name/files?path=config` | `files` |
| `GET /api/v1/instances/:name/files/content?path=server.properties` | `files` |
| `POST /api/v1/instances/:name/diagnostics/profile` with `{ "seconds": 10 }` | `console` |

A setting that needs a restart is not written while the server runs. The answer lists it under `queued`; it is applied before the next start.

### Databases
Needs the database feature (see [database.md](database.md)). A token with the `database` scope reaches the database of each server it may access. The network database also needs a token that is not limited to instances.

| | |
|---|---|
| `GET /api/v1/database` | state of the database engine |
| `GET /api/v1/instances/:name/database` | exists, connection details, table names |
| `POST /api/v1/instances/:name/database/create` | create the database of this server |
| `GET /api/v1/instances/:name/database/tables/:table?limit=50&offset=0` | columns, primary key, total and a page of rows (at most 500) |
| `POST .../database/tables` with `{ "name", "columns": [{ "name", "type", "size?", "nullable?", "autoIncrement?", "default?" }], "primaryKey": [] }` | create a table |
| `DELETE .../database/tables/:table` | delete a table |
| `POST .../database/tables/:table/columns`, `DELETE .../columns/:column` | add or delete a column |
| `POST .../database/tables/:table/rows` with `{ "values": {} }` | insert a row |
| `PATCH .../database/tables/:table/rows` with `{ "key": {}, "values": {} }` | change the row with that primary key |
| `DELETE .../database/tables/:table/rows` with `{ "key": {} }` | delete that row |
| `POST .../database/query` with `{ "sql": "SELECT ..." }` | run one SQL statement (at most 1000 rows come back) |
| `POST .../database/reset-password`, `DELETE .../database` | new password, delete the database |

The same routes exist below `/api/v1/database/shared` for the network database. Everything runs as the database's own user, so a statement can never reach another database.

### Events and webhooks
`GET /api/v1/events` is a Server-Sent Events stream (`events` scope). Reconnect with `Last-Event-ID` (or `?since=<id>`) to get what you missed (the last 200 events are kept).

| Event | When |
|---|---|
| `server.starting` | the server process was started |
| `server.ready` | the server accepts players |
| `server.stopping` | a stop began |
| `server.stopped` | the server is down |
| `server.crashed` | the server died without a stop |
| `server.lag` | the server reported "Can't keep up", with `delayMs` and `ticksBehind` |

```
id: 12
event: server.ready
data: {"id":12,"at":1768650000000,"type":"server.ready","instance":"survival"}
```

Webhooks send the same JSON as a `POST`:

| | Body | Scope |
|---|---|---|
| `GET /api/v1/webhooks` | | `events` |
| `POST /api/v1/webhooks` | `{ "url": "https://…", "events": ["server.crashed"], "name": "chat" }` | `events` |
| `POST /api/v1/webhooks/:id/test` | | `events` |
| `DELETE /api/v1/webhooks/:id` | | `events` |

`events` empty means all events. The response of `POST /webhooks` contains the signing `secret` once.

Each delivery has these headers:

```
X-Meowmarism-Event: server.ready
X-Meowmarism-Delivery: <random id>
X-Meowmarism-Timestamp: <unix seconds>
X-Meowmarism-Signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Check it, and reject old timestamps, before you trust a request. A delivery is retried twice (after 1 s and 5 s) when your server does not answer with 2xx; redirects are not followed. Webhook URLs may point into your local network.

## Examples

Restart nightly from cron:

```
curl -X POST -H "Authorization: Bearer $TOKEN" https://panel/api/v1/instances/survival/restart
```

Warn players, then restart:

```
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Restart in 1 minute"}' https://panel/api/v1/instances/survival/say
```

Verify a webhook in Node.js:

```js
const crypto = require('crypto');
function valid(secret, timestamp, rawBody, header) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

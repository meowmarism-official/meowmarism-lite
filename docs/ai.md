# Letting an AI run the panel

The HTTP API covers everything an assistant needs to build and run a network: create servers and a proxy, link them, install plugins and mods, change settings, send commands, use the database and react to events.

## Setup

1. **Update → Optional features → HTTP API**: switch it on.
2. **API** page → **New token**. Give it the permissions the AI needs. `Everything` is the whole API. The token is shown once.
3. Give the AI three things: the panel address (for example `https://panel.example.com`), the token, and [api.md](api.md).

Treat the token like a password. Keep it out of chats you share and out of public repositories. A token with `instances` can delete servers, and one with `console` can send any command to the server.

To limit the damage, use a token for each job, only with the scopes it needs, and limit it to the instances it should touch. **Renew** replaces a leaked token, **Revoke** ends it.

## A prompt to start from

> You manage a Minecraft network through the HTTP API of my meowmarism panel at PANEL_URL with the bearer token in TOKEN. Read api.md first. Work in small steps and check each result: build one instance at a time and follow GET /api/v1/creation until it is done, start a Paper server once so it creates its configuration before linking it to a proxy, and restart what the answer of a change says needs a restart. Never delete an instance, change a version or send a command that stops a server unless I asked for exactly that.

## A network from scratch

```
GET  /api/v1/versions?loader=velocity            pick a Velocity version
POST /api/v1/instances  { name: "Proxy", loader: "velocity", mcVersion: "3.4.0", port: 25565, ramMB: 1024 }
GET  /api/v1/creation                            repeat until done
POST /api/v1/instances  { name: "Hub", loader: "paper", mcVersion: "1.21.1", port: 25566 }
GET  /api/v1/creation
POST /api/v1/instances/Hub/start                 once, so Paper writes its config
POST /api/v1/instances/Hub/stop
POST /api/v1/instances/Proxy/network  { servers: ["Hub"], tryOrder: ["Hub"] }
POST /api/v1/instances/Hub/start
POST /api/v1/instances/Proxy/start
POST /api/v1/instances/Hub/mods/install { projectId: "..." }
```

Players connect to the proxy's port. See [database.md](database.md) for the database and [api.md](api.md) for every call.

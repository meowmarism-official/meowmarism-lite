<div align="center">

<img src="panel/core/brand/logo.svg" alt="meowmarism" height="72">

# meowmarism LITE

**A self-hosted control panel for your Minecraft servers**

![status](https://img.shields.io/badge/status-active-58b978?style=flat-square)
![loaders](https://img.shields.io/badge/vanilla%20%C2%B7%20paper%20%C2%B7%20purpur%20%C2%B7%20fabric%20%C2%B7%20forge%20%C2%B7%20neoforge-5f9ee8?style=flat-square)
![node](https://img.shields.io/badge/node-%3E%3D18-3c873a?style=flat-square)
![license](https://img.shields.io/badge/license-Meowmarism%201.0-lightgrey?style=flat-square)

No framework, no database, no external services required. Manage multiple Minecraft servers side by side, each in its own isolated process, streamed straight to your browser in real time.

</div>

---

## Features

| | |
|---|---|
| **Live overview** | CPU, RAM, disk & network stats sampled every 50ms, charted live |
| **Console** | Live server output, send commands, full scrollback |
| **Players** | Online list, session history, per-player moderation (kick / ban / op / gamemode) |
| **Settings** | Edit `server.properties` from the browser, live-apply where possible |
| **Mods** | Enable / disable installed mods, browse and install from Modrinth with required dependencies, see and apply updates (Paper and Purpur: plugins) |
| **Server software** | Upgrade Minecraft or the loader with an automatic world backup first and a one-click rollback |
| **Scheduler** | Plan backups, restarts, start / stop and console commands (daily, weekly or interval) |
| **Access** | Manage whitelist, operators and bans |
| **Files** | Browse and inspect files on the server straight from the browser |
| **Backups** | Age-tiered automatic backups (fine-grained recent, thinned older), one-click restore with an automatic safety snapshot first, disk-space aware |
| **Automation** | Daily scheduled restart with an in-chat warning countdown, crash auto-restart with a loop guard, sleep mode (stops when empty, wakes on the next join attempt) |
| **Accounts** | Local accounts with fine-grained per-instance permissions, brute-force protection, HTTPS behind a reverse proxy |
| **Events & Audit** | Full timeline of server lifecycle events and every panel action taken |

---

## Stack

Plain Node.js (`http` + `fs` + `child_process`, no framework), split into a controller and workers:

```
panel/
├── controller.js      the supervisor: instance registry, workers, accounts, updates, HTTPS/proxy handling
├── controller.html    the instance list, users, settings and update pages
├── login.html         login page
├── server.js          worker: manages exactly one Minecraft server (one per instance)
├── index.html         worker frontend: the full dashboard for that instance
├── i18n.js            UI translations
├── lang/              translation files
├── core/              design, brand and shared modules (Modrinth, backups, scheduler, ...) from meowmarism core (generated copy)
├── runtime/           how servers run in LITE: host process, Java and launch options
└── lib/               config, accounts, sessions, update safety net
```

You only ever run the controller directly. It spawns a `server.js` worker per running instance automatically, each with its own port, own console, own stats, nothing shared between instances. Open the controller's port to see the instance list, and click into any running instance to open its full dashboard. The controller proxies each instance, so only the controller's port needs to be reachable.

---

## Configuration

| Variable | Default | Applies to | Purpose |
|---|---|---|---|
| `CONTROLLER_PORT` | `8090` | controller | Port the instance-list UI listens on |
| `WORKER_PORT_BASE` | `9090` | controller | First port handed out to a worker; each new instance gets the next free one |
| `MC_SERVER_DIR` | - | worker | Which instance to manage. Set automatically by the controller when it spawns a worker, no need to set by hand |
| `PANEL_PORT` | `8090` | worker | Which port that worker's dashboard listens on. Also set automatically by the controller |

You generally never touch `MC_SERVER_DIR`/`PANEL_PORT` yourself; they're only relevant if you're running `server.js` directly for local development instead of through the controller.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/meowmarism-official/meowmarism-lite/master/install.sh | bash
```

Nothing needs to be installed beforehand, not even Node.js - the script installs it if it's missing (via your distro's package manager: apt, dnf or yum). It also downloads the latest **tagged release** (not the development branch), installs it to `/opt/meowmarism`, sets up a `systemd` service, and asks you to set a username and password for the panel before it prints the URL to open. Re-run the same command later to update - it always pulls whatever the latest release is at that point. The panel shows a dot on the Update page in the sidebar when a newer release exists and can update itself from there.

Prefer to read the script before piping it into a shell? Download it first: `curl -fsSLO .../install.sh`, read it, then `bash install.sh`.

---

## HTTPS and internet access

The panel speaks plain HTTP on port 8090. That is fine inside a home network. For anything reachable from the internet, put it behind a reverse proxy that terminates HTTPS.

1. Let the panel listen on localhost only and tell it a proxy is in front (set at install time, or add the two `Environment=` lines to the service unit):

   ```
   MEOWMARISM_HOST=127.0.0.1 MEOWMARISM_TRUST_PROXY=1 bash install.sh
   ```

   Alternatively switch on "This panel runs behind an HTTPS reverse proxy" on the Settings page. With it on, the session cookie is `Secure`, HSTS is sent and the login protection uses the client IP from `X-Forwarded-For`. Only enable it when a proxy really sets that header.

2. Caddy (automatic certificates):

   ```
   panel.example.com {
       reverse_proxy 127.0.0.1:8090
   }
   ```

3. nginx:

   ```
   location / {
       proxy_pass http://127.0.0.1:8090;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_http_version 1.1;
       proxy_buffering off;
   }
   ```

The panel shows a warning when it is opened over plain HTTP on a public address. Failed logins are throttled per IP and username (progressive lockout).

---

## License and Contributions

Meowmarism is source-available. Commercial use is permitted subject to the [Meowmarism License 1.0](LICENSE); monetization of the software itself is restricted.

Companies may use it internally, run and sell game servers with it, and offer hosting, support or consulting. What is not allowed is charging for the software itself, for example selling licenses or downloads of it or of a fork, or a paid service whose main product is access to Meowmarism. If you distribute a modified version, its corresponding source must remain public under the same license. Independent versions must be clearly unofficial and follow the naming and attribution requirements in the license. A rebranded fork must say that it is based on Meowmarism and keep the credits. Use of the name and logo follows the [Brand Policy](BRAND-POLICY.md).

Contributions to the official project are governed by the [Meowmarism Contributor & Governance Agreement](CONTRIBUTOR-AGREEMENT.md). Project-level contributor attribution and governance status are recorded in [CONTRIBUTORS.md](CONTRIBUTORS.md).

---

<div align="center">

made with meow :3

</div>

# Question Roller

A family web app that rolls 3D physics dice to randomly select a question from a pool of 1,000+ questions. Family members record their answers as text, audio recordings, and photos — all stored server-side and browsable any time.

---

## Features

- **3D dice roll** — Babylon.js + Ammo.js WebAssembly physics via `@3d-dice/dice-box`
- **1,035 questions** across multiple categories
- **Per-member answers** — select or create a family member before answering
- **Age tracking** — stores each member's date of birth; automatically records how old they were when they answered
- **Audio recording** — record voice answers directly in the browser; automatically transcribed via faster-whisper
- **Photo capture** — take or upload photos, compressed client-side before upload
- **Chunked uploads** — safe for large recordings behind Cloudflare or other proxies (1 MB chunks)
- **Answers panel** — browse all answers, filterable by author, grouped by category
- **Installable PWA** — works as a home screen app on iOS and Android
- **Session auth** — single password protects all data
- **Security hardened** — helmet headers, rate limiting, input validation, mimeType whitelist, file size caps

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- *(Optional)* A [faster-whisper](https://github.com/fedirz/faster-whisper-server) instance for audio transcription

---

## Quick Start

### 1. Clone and configure

```bash
git clone <your-repo-url>
cd questions
cp .env.example .env
```

Edit `.env`:

```env
APP_PASSWORD=your-family-password
SESSION_SECRET=a-long-random-string-change-this
PUID=1000          # run: id -u  to find yours
PGID=1000          # run: id -g  to find yours
ANSWERS_PATH=/path/to/persistent/data/
WHISPER_URL=http://192.168.1.100:8081   # optional
WHISPER_MODEL=Systran/faster-whisper-small
```

### 2. Build and run

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:8180**

### 3. First use

Navigate to the app, enter the password from your `.env`, and tap the screen to roll the dice.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_PASSWORD` | `changeme` | Password to log in to the app |
| `SESSION_SECRET` | `changeme-secret` | Secret key for signing session cookies. Use a long random string. |
| `PUID` | `1000` | User ID the container process runs as. Match your host user (`id -u`). |
| `PGID` | `1000` | Group ID the container process runs as. Match your host group (`id -g`). |
| `ANSWERS_PATH` | `./data` | Host path for persistent data (answers, members, media files) |
| `WHISPER_URL` | `http://localhost:8081` | URL of a faster-whisper server for audio transcription |
| `WHISPER_MODEL` | `Systran/faster-whisper-small` | Whisper model to use. Larger models are more accurate but slower. |

---

## Data Storage

All persistent data lives in the directory set by `ANSWERS_PATH`:

```
data/
├── answers.json      # all saved answers, keyed by question ID
├── members.json      # family members with name and date of birth
├── media/            # uploaded audio recordings and photos
└── tmp/              # temporary chunk assembly (auto-cleared on startup)
```

The container mounts this directory as `/data` inside the container, running as `PUID:PGID` to match your host filesystem permissions.

---

## Audio Transcription (Optional)

Audio recordings are automatically transcribed to text using a [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) instance. This runs as a separate service — it does not need to be on the same machine, just reachable on your local network.

**Example Docker Compose for faster-whisper** (on a separate machine or same compose file):

```yaml
services:
  whisper:
    image: fedirz/faster-whisper-server:latest-cuda   # or latest-cpu
    ports:
      - "8081:8000"
    environment:
      - WHISPER__MODEL=Systran/faster-whisper-small
    volumes:
      - whisper-cache:/root/.cache/huggingface
    restart: unless-stopped

volumes:
  whisper-cache:
```

If `WHISPER_URL` is unreachable or transcription fails, audio is still saved — the transcription just won't auto-fill the answer text.

---

## Installing as a Mobile App (PWA)

The app is a Progressive Web App and can be installed directly to your phone's home screen.

**Android (Chrome):**
1. Open the app in Chrome
2. Tap the three-dot menu → **Add to Home Screen**
3. Chrome may also show an automatic install banner after a few visits

**iPhone (Safari):**
1. Open the app in Safari
2. Tap the **Share** button (box with arrow)
3. Scroll down and tap **Add to Home Screen**

Once installed, the app launches fullscreen without browser chrome, just like a native app.

> Requires HTTPS. If accessing over a local domain, you'll need a valid SSL certificate (e.g., via a reverse proxy like nginx with Let's Encrypt).

---

## Project Structure

```
questions/
├── app/                    # Static frontend (copied into Docker image)
│   ├── index.html          # Main app shell
│   ├── login.html          # Login page
│   ├── login.css           # Login page styles
│   ├── login.js            # Login form logic
│   ├── styles.css          # Main app styles
│   ├── app.js              # Main frontend ES module
│   ├── questions.json      # Question pool (1,035 questions)
│   ├── manifest.json       # PWA manifest
│   ├── service-worker.js   # PWA service worker (network-first)
│   ├── favicon.svg         # Browser tab icon
│   ├── icon.svg            # PWA home screen icon
│   └── icon-maskable.svg   # PWA maskable icon (Android adaptive)
├── server.js               # Express server (API + static serving)
├── entrypoint.sh           # Docker entrypoint (sets up PUID/PGID)
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example            # Environment variable template
└── .dockerignore
```

---

## API Reference

All endpoints except login/logout require a valid session cookie.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/login` | Authenticate with password |
| `POST` | `/api/logout` | End session |
| `GET` | `/api/session` | Check if session is active |
| `GET` | `/api/members` | List all family members |
| `POST` | `/api/members` | Add or update a member `{ name, dob }` |
| `GET` | `/api/answers` | Get all answers (all questions) |
| `GET` | `/api/answers/:id` | Get answers for one question |
| `POST` | `/api/answers/:id` | Save an answer `{ answer, author, audio?, photos? }` |
| `DELETE` | `/api/answers/:id` | Delete all answers for a question |
| `POST` | `/api/upload/chunk` | Upload a file chunk (multipart) |
| `GET` | `/media/:filename` | Serve a media file |

---

## Security

- **Session auth** with `httpOnly`, `sameSite: lax` cookies (7-day expiry)
- **Timing-safe** password comparison (`crypto.timingSafeEqual`)
- **Rate limiting** — 10 login attempts per 15 min; 120 API requests per min
- **HTTP security headers** via [helmet](https://helmetjs.github.io/) (CSP, X-Frame-Options, HSTS, etc.)
- **Input validation** — question IDs, author names (80 char max), answer text (10,000 char max), mimeType whitelist, media path regex
- **Chunked upload limits** — 100 MB max assembled file, 200 max chunks, 2 MB per chunk
- **Whisper timeout** — 60 second max for transcription requests
- **Path traversal protection** — `path.basename()` on all user-supplied filenames

---

## Clearing Data

To start fresh (wipe all answers and members):

```bash
docker compose exec web sh -c "rm -f /data/answers.json /data/members.json"
```

To also remove all uploaded media:

```bash
docker compose exec web sh -c "rm -rf /data/media/* /data/answers.json /data/members.json"
```

---

## Rebuilding After Changes

If you modify any files in `app/` or `server.js`:

```bash
docker compose up -d --build
```

If you only changed `server.js` (no npm dependency changes), a restart is enough:

```bash
docker compose restart web
```

---

## Adding Questions

Questions live in `app/questions.json`. Each entry requires:

```json
{
  "id": 1036,
  "category": "Childhood",
  "question": "What is your earliest memory?"
}
```

IDs must be unique. After editing, rebuild the image:

```bash
docker compose up -d --build
```

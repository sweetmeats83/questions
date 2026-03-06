# Question Roller

A family web app that rolls 3D physics dice to randomly select a question from a pool of 1,000+ questions. Family members record answers as text, voice recordings, and photos — all stored locally and browsable any time.

> **Vibe coded** — built entirely with AI assistance (Claude Code).

## Features

- 3D physics dice roll (Babylon.js + Ammo.js WASM)
- 1,035 questions across multiple categories
- Per-member answers with age tracking
- Auto-read questions aloud via TTS; toggle on/off per session
- Voice recording with automatic Whisper transcription
- Photo capture with client-side compression
- Multiple answers per person — replace or add over the years
- Browsable answers panel, filterable by author, with 🔊 read-aloud and ✏ edit buttons
- Installable PWA (iOS + Android)
- Session auth, helmet headers, rate limiting

## Companion Containers

This image is designed to run alongside **[speaches](https://github.com/speaches-ai/speaches)**, which provides:

- **Speech-to-text** — voice recordings transcribed via faster-whisper
- **Text-to-speech** — questions read aloud via Kokoro TTS

STT and TTS gracefully degrade if speaches is unavailable — audio is still saved, questions just won't auto-read.

> Speaches requires an NVIDIA GPU. If you don't have one, omit those services and leave `WHISPER_URL`/`TTS_URL` unset.

## Quick Start

**1. Create a `docker-compose.yml`:**

```yaml
services:
  web:
    image: sweetmeats83/question-roller:latest
    ports:
      - "8180:3000"
    env_file: .env
    volumes:
      - ${ANSWERS_PATH:-./data}:/data
    depends_on:
      - speaches
    restart: unless-stopped

  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cuda-12.6.3
    ports:
      - "8082:8000"
    volumes:
      - /path/to/models/cache:/home/ubuntu/.cache/huggingface/hub
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8000/ || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 15s
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

  speaches-init:
    image: curlimages/curl:latest
    depends_on:
      speaches:
        condition: service_healthy
    command: >
      sh -c "
        curl -sX POST http://speaches:8000/v1/models/Systran%2Ffaster-whisper-small &&
        curl -sX POST http://speaches:8000/v1/models/speaches-ai%2FKokoro-82M-v1.0-ONNX
      "
    restart: on-failure
```

**2. Create a `.env` file:**

```env
APP_PASSWORD=your-family-password
SESSION_SECRET=a-long-random-string-change-this
PUID=1000
PGID=1000
ANSWERS_PATH=/path/to/persistent/data/
WHISPER_URL=http://speaches:8000
WHISPER_MODEL=Systran/faster-whisper-small
TTS_URL=http://speaches:8000
TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX
TTS_VOICE=af_heart
```

**3. Run:**

```bash
docker compose up -d
```

App available at **http://localhost:8180**

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `APP_PASSWORD` | `changeme` | Login password |
| `SESSION_SECRET` | `changeme-secret` | Cookie signing secret — use a long random string |
| `PUID` / `PGID` | `1000` | Run as this user/group (match your host: `id -u`, `id -g`) |
| `ANSWERS_PATH` | `./data` | Host path for persistent data |
| `WHISPER_URL` | `http://speaches:8000` | STT server URL |
| `WHISPER_MODEL` | `Systran/faster-whisper-small` | Whisper model ID |
| `TTS_URL` | `http://speaches:8000` | TTS server URL |
| `TTS_MODEL` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | TTS model ID |
| `TTS_VOICE` | `af_heart` | Kokoro voice (`af_heart`, `af_bella`, `am_michael`, `am_adam`, `bf_emma`, `bm_george`) |

## Data

All persistent data lives in `ANSWERS_PATH` (mounted as `/data` inside the container):

```
data/
├── answers.json
├── members.json
├── media/
└── tmp/
```

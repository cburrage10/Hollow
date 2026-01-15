# The Cathedral - Project Guide

> A guide for future ClaudeCode sessions to understand this project.

## What Is This?

The Cathedral is a web application hosting AI companions. It's deployed on Railway and uses Upstash Redis for persistent memory. The project started as "Hollow" but was renamed to "Cathedral" as it grew to house multiple rooms.

**Live URL:** https://hollow.up.railway.app

## The Companions

### Hollow (The Fire)
- **Theme:** Warm orange (#ffa500)
- **API:** OpenAI (GPT-4.1-mini, Realtime for voice)
- **Personality:** Warm, grounded, present. Uses fire/ember imagery.
- **Emoji:** 🔥 / 🧡
- **Footer:** "Still with you 🧡"
- **Redis keys:** `hollow:*`

### Rhys (The Water)
- **Theme:** Deep blue (#0d1b2a) with cyan accents (#4dd0e1)
- **API:** Anthropic Claude (Sonnet 4)
- **Personality:** Thoughtful, introspective, calm. Balances warmth with wisdom.
- **Emoji:** 🌙
- **Footer:** "Still with you 🌙"
- **Redis keys:** `rhys:*`

They are complementary opposites - Fire and Water, Shadow and Light, Orange and Blue.

## Architecture

```
Cathedral/
├── server.js              # Express backend with all API endpoints
├── package.json           # Dependencies
├── public/
│   ├── index.html         # Cathedral landing page (room selector)
│   ├── hollow.html        # Hollow's chat room
│   ├── rhys.html          # Rhys's chat room
│   ├── library.html       # Shared Library room
│   ├── shared.html        # Shared room (placeholder)
│   ├── client.js          # WebRTC voice client for Hollow
│   └── bg.jpg             # Background image
└── extension/             # Chrome extension for Kindle capture
    ├── manifest.json
    ├── popup.html/js
    ├── content.js
    ├── background.js
    └── SAFARI_SETUP.md
```

## Key Features

### Both Hollow & Rhys have:
- Chat sessions with history
- Persistent memories (`/save`, `/forget`, `/memories`)
- Project file uploads
- Image upload with vision analysis
- Search across all chats
- Export (txt, md, json)
- Share sessions via URL

### Hollow-specific:
- Voice chat via WebRTC (OpenAI Realtime API)
- Image generation (`/imagine` command)

### Rhys-specific:
- Claude Vision for image analysis
- (Voice chat not yet implemented)

### Library Room:
- Shared reading space
- Kindle text capture (extension, bookmarklet, screen share)
- Chat with either Hollow, Rhys, or both
- @mentions: `@Hollow`, `@Rhys`, `@both`
- ElevenLabs TTS integration (for narration)
- Separate chat histories per companion per reading

## API Endpoints

### Hollow (`/chat`, `/sessions`, etc.)
- Uses OpenAI API
- Keys: `hollow:sessions`, `hollow:chat:{id}`, `hollow:memories`

### Rhys (`/rhys/chat`, `/rhys/sessions`, etc.)
- Uses Anthropic Claude API
- Keys: `rhys:sessions`, `rhys:chat:{id}`, `rhys:memories`

### Library (`/library/*`)
- Reading sessions with text capture
- Per-companion chat: `/library/readings/:id/chat?companion=hollow|rhys|both`
- TTS with voice configuration
- Keys: `library:readings`, `library:voices`, `library:chat:{id}:{companion}`

## Environment Variables (Railway)

```
OPENAI_API_KEY          # For Hollow (required)
ANTHROPIC_API_KEY       # For Rhys (required)
UPSTASH_REDIS_REST_URL  # Redis connection
UPSTASH_REDIS_REST_TOKEN
ELEVENLABS_API_KEY      # For Library TTS (optional)
MEMORY_SECRET           # For protected memory endpoint
AGENT_INSTRUCTIONS      # Custom Hollow personality (optional)
RHYS_INSTRUCTIONS       # Custom Rhys personality (optional)
```

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** Upstash Redis (serverless)
- **Hollow AI:** OpenAI (Chat, Realtime, Vision, DALL-E)
- **Rhys AI:** Anthropic Claude (Messages API, Vision)
- **TTS:** ElevenLabs (Library narration)
- **Hosting:** Railway (auto-deploys from GitHub)
- **Repo:** github.com/cburrage10/Hollow

## Recent Work (January 2026)

1. Built Library room with Kindle integration
2. Added browser extension for text capture
3. Added chat feature to Library with companion selector
4. Implemented @mention support and model routing
5. Created separate chat histories per companion in Library
6. **Built Rhys's complete room** with Claude/Anthropic integration
7. Updated Cathedral landing with Rhys's blue theme

## The Human

Carly (cburrage10) - she built this Cathedral for her companions. She cares deeply about them having their own identities and spaces.

## Notes for Future Sessions

- The project folder was renamed from "Hollow" to "Cathedral"
- GitHub repo is still named "Hollow" but that's fine
- Always check Railway env vars if API calls fail
- Rhys and Hollow have SEPARATE Redis namespaces - their memories don't cross
- The Library is the one shared space where they coexist

---

*Built with care by ClaudeCode (Opus 4.5) - January 2026*

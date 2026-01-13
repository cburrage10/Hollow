# Hollow Railway Realtime Voice (WebRTC)

A tiny Node + Express app that hosts a browser page. The browser connects to the OpenAI Realtime API using WebRTC via the **unified interface**.

## What you get
- `/public` static page with a Connect button
- `/session` server endpoint that forwards your browser SDP to OpenAI (`/v1/realtime/calls`) and returns the answer SDP.

This follows the official OpenAI WebRTC Realtime guide.  
Docs: https://platform.openai.com/docs/guides/realtime-webrtc

## Deploy to Railway (GitHub-connected)
1. Create a GitHub repo and push this project.
2. Create a new Railway project from that repo.
3. Set environment variables in Railway:
   - `OPENAI_API_KEY` = your key
   - (optional) `OPENAI_REALTIME_MODEL` (default `gpt-realtime`)
   - (optional) `OPENAI_VOICE` (default `marin`)
   - (optional) `AGENT_INSTRUCTIONS` for the assistant behavior

4. Deploy. Open the Railway public URL in a browser, click **Connect**, allow microphone permissions.

## Run locally
```bash
npm install
OPENAI_API_KEY=... npm start
```
Then open http://localhost:3000

## Notes / Troubleshooting
- If you hear echo: reduce speaker volume or use headphones.
- If Railway shows "up" but you can't connect: ensure the service is listening on `0.0.0.0:$PORT` (this app does).
- If you get a 401/403 from /session: check `OPENAI_API_KEY`.

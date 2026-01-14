import express from "express";
import { Redis } from "@upstash/redis";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import crypto from "crypto";

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedText = ["text/plain", "application/pdf", "text/markdown", "text/csv"];
    const allowedImages = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedText.includes(file.mimetype) || allowedImages.includes(file.mimetype) ||
        file.originalname.match(/\.(txt|pdf|md|csv|jpg|jpeg|png|gif|webp)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"));
    }
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

// Secret key for accessing memory endpoints (set in Railway env vars)
const MEMORY_SECRET = process.env.MEMORY_SECRET;

// Initialize Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Serve static files
app.use(express.static("public"));

// Route for Hollow's chat
app.get("/hollow", (req, res) => {
  res.sendFile("hollow.html", { root: "public" });
});

// Route for Rhys's chat (placeholder)
app.get("/rhys", (req, res) => {
  res.sendFile("rhys.html", { root: "public" });
});

// Route for Shared room (placeholder)
app.get("/shared", (req, res) => {
  res.sendFile("shared.html", { root: "public" });
});

// Parse JSON bodies for /chat
app.use(express.json());

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// Keys
const MEMORIES_KEY = "hollow:memories";
const MEMORY_COUNTER_KEY = "hollow:memory_counter";
const SESSIONS_KEY = "hollow:sessions"; // List of all session IDs
const MAX_HISTORY = 100;

// Generate a short session ID
function generateSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

// Get chat history key for a session
function getChatKey(sessionId) {
  return `hollow:chat:${sessionId}`;
}

// Get recent chat history for a session
async function getChatHistory(sessionId) {
  try {
    const key = getChatKey(sessionId);
    const history = await redis.lrange(key, 0, MAX_HISTORY - 1);
    return history || [];
  } catch (e) {
    console.error("Error getting chat history:", e);
    return [];
  }
}

// Add message to chat history for a session
async function addToHistory(sessionId, role, content, image = null) {
  try {
    const key = getChatKey(sessionId);
    const entry = JSON.stringify({ role, content, image, timestamp: Date.now() });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, MAX_HISTORY - 1);
  } catch (e) {
    console.error("Error adding to history:", e);
  }
}

// Get all sessions
async function getSessions() {
  try {
    const sessions = await redis.get(SESSIONS_KEY);
    return sessions || [];
  } catch (e) {
    console.error("Error getting sessions:", e);
    return [];
  }
}

// Save sessions list
async function saveSessions(sessions) {
  try {
    await redis.set(SESSIONS_KEY, sessions);
  } catch (e) {
    console.error("Error saving sessions:", e);
  }
}

// Create a new session
async function createSession(name = null) {
  const id = generateSessionId();
  const sessions = await getSessions();
  sessions.unshift({
    id,
    name: name || `Chat ${sessions.length + 1}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  await saveSessions(sessions);
  return id;
}

// Update session timestamp
async function touchSession(sessionId) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.updatedAt = Date.now();
    await saveSessions(sessions);
  }
}

// Rename a session
async function renameSession(sessionId, name) {
  const sessions = await getSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.name = name;
    await saveSessions(sessions);
    return true;
  }
  return false;
}

// Delete a session
async function deleteSession(sessionId) {
  const sessions = await getSessions();
  const index = sessions.findIndex(s => s.id === sessionId);
  if (index !== -1) {
    sessions.splice(index, 1);
    await saveSessions(sessions);
    await redis.del(getChatKey(sessionId));
    return true;
  }
  return false;
}

// Get stored memories
async function getMemories() {
  try {
    const memories = await redis.get(MEMORIES_KEY);
    return memories || [];
  } catch (e) {
    console.error("Error getting memories:", e);
    return [];
  }
}

// Save memories
async function saveMemories(memories) {
  try {
    await redis.set(MEMORIES_KEY, memories);
  } catch (e) {
    console.error("Error saving memories:", e);
  }
}

// Get next memory ID
async function getNextMemoryId() {
  try {
    const id = await redis.incr(MEMORY_COUNTER_KEY);
    return id;
  } catch (e) {
    console.error("Error getting memory ID:", e);
    return Date.now();
  }
}

// Add a new memory
async function addMemory(text) {
  const memories = await getMemories();
  const id = await getNextMemoryId();
  memories.push({ id, text, createdAt: Date.now() });
  await saveMemories(memories);
  return id;
}

// Delete a memory by ID
async function deleteMemory(id) {
  const memories = await getMemories();
  const numId = parseInt(id, 10);
  const index = memories.findIndex(m => m.id === numId);
  if (index === -1) return false;
  memories.splice(index, 1);
  await saveMemories(memories);
  return true;
}

// Build context from history and memories
function buildContext(history, memories) {
  let context = "";

  if (memories.length > 0) {
    context += "Things you remember about the user:\n";
    memories.forEach((m) => {
      context += `- ${m.text}\n`;
    });
    context += "\n";
  }

  if (history.length > 0) {
    context += "Recent conversation:\n";
    const chronological = [...history].reverse();
    chronological.forEach((entry) => {
      try {
        const msg = typeof entry === "string" ? JSON.parse(entry) : entry;
        const role = msg.role === "user" ? "User" : "Hollow";
        context += `${role}: ${msg.content}\n`;
      } catch (e) {}
    });
  }

  return context;
}

// Format memories list for display
function formatMemoriesList(memories) {
  if (memories.length === 0) {
    return "No memories saved yet. Use /save <text> to add one.";
  }
  let list = "Saved memories:\n";
  memories.forEach((m) => {
    list += `[${m.id}] ${m.text}\n`;
  });
  list += "\nUse /forget <id> to remove a memory.";
  return list;
}

const baseInstructions = process.env.AGENT_INSTRUCTIONS || "You are Hollow, a warm, grounded companion. Be concise, kind, and helpful.";

// Voice session endpoint for WebRTC
app.post("/session", async (req, res) => {
  try {
    const sdpOffer = req.body;

    const tokenResponse = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17",
        voice: process.env.OPENAI_VOICE || "echo",
        instructions: baseInstructions,
      }),
    });

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      return res.status(tokenResponse.status).send(err);
    }

    const sessionData = await tokenResponse.json();
    const ephemeralKey = sessionData.client_secret?.value;

    if (!ephemeralKey) {
      return res.status(500).send("Failed to get ephemeral key");
    }

    const realtimeResponse = await fetch(
      `https://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17"}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: sdpOffer,
      }
    );

    if (!realtimeResponse.ok) {
      const err = await realtimeResponse.text();
      return res.status(realtimeResponse.status).send(err);
    }

    const sdpAnswer = await realtimeResponse.text();
    res.type("application/sdp").send(sdpAnswer);
  } catch (e) {
    console.error("Session error:", e);
    res.status(500).send(String(e));
  }
});

// === Session Management Endpoints ===

// Get all sessions
app.get("/sessions", async (req, res) => {
  const sessions = await getSessions();
  res.json({ sessions });
});

// Create new session
app.post("/sessions", async (req, res) => {
  const name = req.body?.name;
  const id = await createSession(name);
  const sessions = await getSessions();
  res.json({ id, sessions });
});

// Rename session
app.patch("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const success = await renameSession(id, name);
  res.json({ success });
});

// Delete session
app.delete("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const success = await deleteSession(id);
  res.json({ success });
});

// Get chat history for a session
app.get("/sessions/:id/history", async (req, res) => {
  const { id } = req.params;
  const history = await getChatHistory(id);
  // Return in chronological order
  res.json({ history: [...history].reverse() });
});

// Clear chat history for a session
app.delete("/sessions/:id/history", async (req, res) => {
  const { id } = req.params;
  await redis.del(getChatKey(id));
  res.json({ success: true });
});

// Search across all chats
app.get("/search", async (req, res) => {
  const query = (req.query.q || "").toLowerCase().trim();
  if (!query) {
    return res.json({ results: [] });
  }

  try {
    const sessions = await getSessions();
    const results = [];

    for (const session of sessions) {
      const history = await getChatHistory(session.id);

      for (const entry of history) {
        const msg = typeof entry === "string" ? JSON.parse(entry) : entry;
        if (msg.content && msg.content.toLowerCase().includes(query)) {
          results.push({
            sessionId: session.id,
            sessionName: session.name,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            image: msg.image
          });
        }
      }
    }

    // Sort by timestamp descending (newest first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Limit to 50 results
    res.json({ results: results.slice(0, 50) });
  } catch (e) {
    console.error("Search error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Memory count endpoint (public)
app.get("/memory-count", async (req, res) => {
  const memories = await getMemories();
  res.json({ count: memories.length });
});

// File upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const sessionId = req.body.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required" });
    }

    const file = req.file;
    const message = req.body.message || "";
    const isImage = file.mimetype.startsWith("image/");

    const [history, memories] = await Promise.all([
      getChatHistory(sessionId),
      getMemories(),
    ]);

    const context = buildContext(history, memories);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant.`;

    let response = "";

    if (isImage) {
      const base64Image = file.buffer.toString("base64");
      const mimeType = file.mimetype;

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          instructions: fullInstructions,
          input: [
            { type: "input_text", text: message },
            { type: "input_image", image_url: `data:${mimeType};base64,${base64Image}` }
          ],
        }),
      });

      const raw = await r.text();
      if (!r.ok) return res.status(r.status).json({ error: raw });

      const data = JSON.parse(raw);

      for (const item of data.output || []) {
        for (const c of item.content || []) {
          if (c.type === "output_text" && c.text) response += c.text;
        }
      }
    } else {
      let fileContent = "";

      if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
        const pdfData = await pdf(file.buffer);
        fileContent = pdfData.text;
      } else {
        fileContent = file.buffer.toString("utf-8");
      }

      if (fileContent.length > 15000) {
        fileContent = fileContent.substring(0, 15000) + "\n...[truncated]";
      }

      const input = `The user uploaded a file named "${file.originalname}".

FILE CONTENT:
---
${fileContent}
---

User's message: ${message}`;

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          instructions: fullInstructions,
          input: input,
        }),
      });

      const raw = await r.text();
      if (!r.ok) return res.status(r.status).json({ error: raw });

      const data = JSON.parse(raw);

      for (const item of data.output || []) {
        for (const c of item.content || []) {
          if (c.type === "output_text" && c.text) response += c.text;
        }
      }
    }

    response = response || "(No text output)";

    await addToHistory(sessionId, "user", `[Uploaded ${isImage ? "image" : "file"}: ${file.originalname}] ${message}`);
    await addToHistory(sessionId, "assistant", response);
    await touchSession(sessionId);

    res.json({ text: response, filename: file.originalname });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    const sessionId = req.body?.sessionId;

    if (!text) return res.json({ text: "" });
    if (!sessionId) return res.status(400).json({ error: "Session ID required" });

    // Handle /save command
    if (text.startsWith("/save ")) {
      const memoryText = text.slice(6).trim();
      if (!memoryText) {
        return res.json({ text: "Usage: /save <text to remember>" });
      }
      const id = await addMemory(memoryText);
      return res.json({ text: `Memory saved with ID [${id}]: "${memoryText}"` });
    }

    // Handle /forget command
    if (text.startsWith("/forget ")) {
      const id = text.slice(8).trim();
      if (!id) {
        return res.json({ text: "Usage: /forget <id>" });
      }
      const deleted = await deleteMemory(id);
      if (deleted) {
        return res.json({ text: `Memory [${id}] has been forgotten.` });
      } else {
        return res.json({ text: `No memory found with ID [${id}].` });
      }
    }

    // Handle /memories command
    if (text === "/memories") {
      const memories = await getMemories();
      return res.json({ text: formatMemoriesList(memories) });
    }

    // Handle /imagine command
    if (text.startsWith("/imagine ")) {
      const prompt = text.slice(9).trim();
      if (!prompt) {
        return res.json({ text: "Usage: /imagine <description of image>" });
      }

      try {
        const r = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            quality: "standard",
          }),
        });

        if (!r.ok) {
          const err = await r.text();
          return res.status(r.status).json({ error: `Image generation failed: ${err}` });
        }

        const data = await r.json();
        const imageUrl = data.data?.[0]?.url;
        const revisedPrompt = data.data?.[0]?.revised_prompt;

        if (imageUrl) {
          await addToHistory(sessionId, "user", `/imagine ${prompt}`);
          await addToHistory(sessionId, "assistant", revisedPrompt ? `Here's what I created: "${revisedPrompt}"` : "Here's your image!", imageUrl);
          await touchSession(sessionId);
          return res.json({
            text: revisedPrompt ? `Here's what I created: "${revisedPrompt}"` : "Here's your image!",
            image: imageUrl
          });
        } else {
          return res.json({ error: "Failed to generate image" });
        }
      } catch (e) {
        console.error("Image generation error:", e);
        return res.json({ error: String(e.message || e) });
      }
    }

    // Regular chat
    const [history, memories] = await Promise.all([
      getChatHistory(sessionId),
      getMemories(),
    ]);

    const context = buildContext(history, memories);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. Be personal and remember who they are.

The user can use these commands:
- /save <text> - Save something to your memory
- /forget <id> - Remove a memory by ID
- /memories - List all saved memories
- /imagine <prompt> - Generate an image`;

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: fullInstructions,
        input: text,
      }),
    });

    const raw = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: raw });

    const data = JSON.parse(raw);

    let out = "";
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) out += c.text;
      }
    }

    const response = out || "(No text output)";

    await addToHistory(sessionId, "user", text);
    await addToHistory(sessionId, "assistant", response);
    await touchSession(sessionId);

    res.json({ text: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Protected endpoint to view memories
app.get("/memories", async (req, res) => {
  if (!MEMORY_SECRET || req.query.key !== MEMORY_SECRET) {
    return res.status(403).json({ error: "Access denied" });
  }
  const memories = await getMemories();
  res.json({ memories });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

import express from "express";
import { Redis } from "@upstash/redis";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";

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

// Serve the tiny browser client
app.use(express.static("public"));

// Parse JSON bodies for /chat
app.use(express.json());

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// Memory keys
const CHAT_HISTORY_KEY = "hollow:chat_history";
const MEMORIES_KEY = "hollow:memories";
const MEMORY_COUNTER_KEY = "hollow:memory_counter";
const MAX_HISTORY = 50;

// Get recent chat history
async function getChatHistory() {
  try {
    const history = await redis.lrange(CHAT_HISTORY_KEY, 0, MAX_HISTORY - 1);
    return history || [];
  } catch (e) {
    console.error("Error getting chat history:", e);
    return [];
  }
}

// Add message to chat history
async function addToHistory(role, content) {
  try {
    const entry = JSON.stringify({ role, content, timestamp: Date.now() });
    await redis.lpush(CHAT_HISTORY_KEY, entry);
    await redis.ltrim(CHAT_HISTORY_KEY, 0, MAX_HISTORY - 1);
  } catch (e) {
    console.error("Error adding to history:", e);
  }
}

// Get stored memories (now with IDs)
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

    // Create ephemeral token for Realtime API
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

    // Connect to Realtime API with SDP offer
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

// Memory count endpoint (public)
app.get("/memory-count", async (req, res) => {
  const memories = await getMemories();
  res.json({ count: memories.length });
});

// Clear chat history endpoint
app.post("/clear-chat", async (req, res) => {
  try {
    await redis.del(CHAT_HISTORY_KEY);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// File upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;
    const message = req.body.message || "";
    const isImage = file.mimetype.startsWith("image/");

    // Get history and memories
    const [history, memories] = await Promise.all([
      getChatHistory(),
      getMemories(),
    ]);

    const context = buildContext(history, memories);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant.`;

    let response = "";

    if (isImage) {
      // Handle image with GPT-4 vision
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
      // Handle text-based files
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

    // Store in history
    await addToHistory("user", `[Uploaded ${isImage ? "image" : "file"}: ${file.originalname}] ${message}`);
    await addToHistory("assistant", response);

    res.json({ text: response, filename: file.originalname });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.json({ text: "" });

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

    // Handle /memories command - list all memories
    if (text === "/memories") {
      const memories = await getMemories();
      return res.json({ text: formatMemoriesList(memories) });
    }

    // Handle /imagine command - generate images with DALL-E
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
          await addToHistory("user", `[Generated image: ${prompt}]`);
          await addToHistory("assistant", `Created an image: ${revisedPrompt || prompt}`);
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

    // Regular chat - get history and memories
    const [history, memories] = await Promise.all([
      getChatHistory(),
      getMemories(),
    ]);

    // Build context
    const context = buildContext(history, memories);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. Be personal and remember who they are.

The user can use these commands:
- /save <text> - Save something to your memory
- /forget <id> - Remove a memory by ID
- /memories - List all saved memories`;

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

    // Store in history
    await addToHistory("user", text);
    await addToHistory("assistant", response);

    res.json({ text: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Protected endpoint to view memories (requires secret key)
app.get("/memories", async (req, res) => {
  if (!MEMORY_SECRET || req.query.key !== MEMORY_SECRET) {
    return res.status(403).json({ error: "Access denied" });
  }
  const memories = await getMemories();
  res.json({ memories });
});

// Protected endpoint to view chat history (requires secret key)
app.get("/history", async (req, res) => {
  if (!MEMORY_SECRET || req.query.key !== MEMORY_SECRET) {
    return res.status(403).json({ error: "Access denied" });
  }
  const history = await getChatHistory();
  res.json({ history });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

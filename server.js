import express from "express";
import { Redis } from "@upstash/redis";

const app = express();
const PORT = process.env.PORT || 3000;

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
const MAX_HISTORY = 50; // Keep last 50 messages for context

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

// Get stored memories (key facts about the user)
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

// Extract key facts from conversation using AI
async function extractMemories(userMessage, assistantResponse, existingMemories) {
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: `You are a memory extraction assistant. Given a conversation snippet and existing memories, extract any NEW important facts about the user that should be remembered long-term.

Return a JSON array of strings - each string is a memory/fact. Only include NEW information not already in existing memories. Focus on:
- Personal details (name, preferences, interests)
- Important events or dates mentioned
- Relationships and people they mention
- Goals, projects, or things they're working on
- Preferences and opinions

If there's nothing new worth remembering, return an empty array: []

ONLY return valid JSON array, nothing else.`,
        input: `Existing memories: ${JSON.stringify(existingMemories)}

User said: "${userMessage}"
Assistant replied: "${assistantResponse}"

New memories to add (JSON array):`,
      }),
    });

    if (!r.ok) return [];

    const data = await r.json();
    let out = "";
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) out += c.text;
      }
    }

    const parsed = JSON.parse(out.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Error extracting memories:", e);
    return [];
  }
}

// Build context from history and memories
function buildContext(history, memories) {
  let context = "";

  if (memories.length > 0) {
    context += "Things you remember about the user:\n";
    memories.forEach((m, i) => {
      context += `- ${m}\n`;
    });
    context += "\n";
  }

  if (history.length > 0) {
    context += "Recent conversation:\n";
    // Reverse to get chronological order (oldest first)
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

const baseInstructions = process.env.AGENT_INSTRUCTIONS || "You are Hollow, a warm, grounded companion. Be concise, kind, and helpful.";

app.post("/chat", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.json({ text: "" });

    // Get history and memories
    const [history, memories] = await Promise.all([
      getChatHistory(),
      getMemories(),
    ]);

    // Build context
    const context = buildContext(history, memories);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. Be personal and remember who they are.`;

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

    // Extract and save new memories (async, don't wait)
    extractMemories(text, response, memories).then(async (newMemories) => {
      if (newMemories.length > 0) {
        const updated = [...memories, ...newMemories];
        await saveMemories(updated);
        console.log("New memories saved:", newMemories);
      }
    });

    res.json({ text: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Endpoint to view memories (for debugging)
app.get("/memories", async (req, res) => {
  const memories = await getMemories();
  res.json({ memories });
});

// Endpoint to view chat history (for debugging)
app.get("/history", async (req, res) => {
  const history = await getChatHistory();
  res.json({ history });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

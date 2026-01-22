import express from "express";
import { Redis } from "@upstash/redis";
import multer from "multer";
import pdf from "pdf-parse/lib/pdf-parse.js";
import crypto from "crypto";
import { Blob } from "buffer";

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedText = ["text/plain", "application/pdf", "text/markdown", "text/csv"];
    const allowedImages = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const allowedAudio = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg"];
    if (allowedText.includes(file.mimetype) || allowedImages.includes(file.mimetype) ||
        allowedAudio.includes(file.mimetype) ||
        file.originalname.match(/\.(txt|pdf|md|csv|jpg|jpeg|png|gif|webp|webm|mp3|wav|ogg|m4a)$/i)) {
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

// Tavily search function
async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { error: "Search not configured (missing API key)" };
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Tavily error:", err);
      return { error: "Search failed" };
    }

    const data = await response.json();
    return {
      answer: data.answer,
      results: data.results?.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 300),
      })) || [],
    };
  } catch (e) {
    console.error("Tavily search error:", e);
    return { error: String(e.message || e) };
  }
}

// Format search results for display
function formatSearchResults(searchData) {
  if (searchData.error) {
    return `Search error: ${searchData.error}`;
  }

  let output = "";
  if (searchData.answer) {
    output += `**Summary:** ${searchData.answer}\n\n`;
  }
  if (searchData.results?.length) {
    output += "**Sources:**\n";
    for (const r of searchData.results) {
      output += `- [${r.title}](${r.url})\n  ${r.snippet}...\n\n`;
    }
  }
  return output || "No results found.";
}

// === Opie Tools (GitHub API for Rhys to edit Cathedral) ===
const GITHUB_OWNER = "cburrage10";
const GITHUB_REPO = "Hollow";
const GITHUB_BRANCH = "main";

async function opieReadFile(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { error: "GitHub not configured (missing token)" };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { error: `File not found: ${path}` };
      }
      return { error: `GitHub API error: ${response.status}` };
    }

    const data = await response.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha, path: data.path };
  } catch (e) {
    console.error("opieReadFile error:", e);
    return { error: String(e.message || e) };
  }
}

async function opieListFiles(path = "") {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { error: "GitHub not configured (missing token)" };
  }

  try {
    const url = path
      ? `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`
      : `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents?ref=${GITHUB_BRANCH}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      return { error: `GitHub API error: ${response.status}` };
    }

    const data = await response.json();
    const files = Array.isArray(data)
      ? data.map((f) => ({ name: f.name, type: f.type, path: f.path }))
      : [{ name: data.name, type: data.type, path: data.path }];

    return { files };
  } catch (e) {
    console.error("opieListFiles error:", e);
    return { error: String(e.message || e) };
  }
}

async function opieEditFile(path, oldString, newString, commitMessage) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { error: "GitHub not configured (missing token)" };
  }

  try {
    // First, read the current file to get its content and SHA
    const readResult = await opieReadFile(path);
    if (readResult.error) {
      return readResult;
    }

    const { content, sha } = readResult;

    // Check if oldString exists in the file
    if (!content.includes(oldString)) {
      return { error: `Could not find the text to replace in ${path}. Make sure the old_string matches exactly.` };
    }

    // Check if oldString appears multiple times
    const occurrences = content.split(oldString).length - 1;
    if (occurrences > 1) {
      return { error: `Found ${occurrences} occurrences of the text in ${path}. Please provide more context to make it unique.` };
    }

    // Perform the replacement
    const newContent = content.replace(oldString, newString);

    // Commit the change
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: commitMessage || `Rhys edit: ${path}`,
          content: Buffer.from(newContent).toString("base64"),
          sha: sha,
          branch: GITHUB_BRANCH,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("GitHub commit error:", err);
      return { error: `Failed to commit: ${response.status}` };
    }

    const data = await response.json();
    return {
      success: true,
      message: `Successfully edited ${path}`,
      commit: data.commit?.sha?.slice(0, 7),
    };
  } catch (e) {
    console.error("opieEditFile error:", e);
    return { error: String(e.message || e) };
  }
}

// Tool definitions for Anthropic API
const opieTools = [
  {
    name: "opie_read_file",
    description: "Read the contents of a file from the Cathedral codebase. Use this to understand existing code before making changes.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path relative to the repository root (e.g., 'server.js', 'public/rhys.html')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "opie_list_files",
    description: "List files and directories in the Cathedral codebase. Use this to explore the project structure.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The directory path to list (e.g., 'public', 'extension'). Leave empty for root directory.",
        },
      },
      required: [],
    },
  },
  {
    name: "opie_edit_file",
    description: "Edit a file in the Cathedral codebase by replacing specific text. This will commit the change to GitHub and trigger a deploy. Use carefully and always read the file first to understand its contents.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path relative to the repository root",
        },
        old_string: {
          type: "string",
          description: "The exact text to find and replace (must be unique in the file)",
        },
        new_string: {
          type: "string",
          description: "The new text to replace it with",
        },
        commit_message: {
          type: "string",
          description: "A brief description of the change for the git commit",
        },
      },
      required: ["path", "old_string", "new_string", "commit_message"],
    },
  },
];

// Execute an Opie tool
async function executeOpieTool(toolName, toolInput) {
  switch (toolName) {
    case "opie_read_file":
      return await opieReadFile(toolInput.path);
    case "opie_list_files":
      return await opieListFiles(toolInput.path || "");
    case "opie_edit_file":
      return await opieEditFile(
        toolInput.path,
        toolInput.old_string,
        toolInput.new_string,
        toolInput.commit_message
      );
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

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

// Route for Library
app.get("/library", (req, res) => {
  res.sendFile("library.html", { root: "public" });
});

// Parse JSON bodies for /chat
app.use(express.json());

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// Keys
const MEMORIES_KEY = "hollow:memories";
const MEMORY_COUNTER_KEY = "hollow:memory_counter";
const SESSIONS_KEY = "hollow:sessions"; // List of all session IDs
const PROJECT_FILES_KEY = "hollow:project_files";
const MAX_HISTORY = 100;
const MAX_FILE_CONTENT = 50000; // Max chars per file to store

// Library Keys
const LIBRARY_READINGS_KEY = "library:readings";
const LIBRARY_VOICES_KEY = "library:voices";

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

// === Project Files ===

// Get all project files
async function getProjectFiles() {
  try {
    const files = await redis.get(PROJECT_FILES_KEY);
    return files || [];
  } catch (e) {
    console.error("Error getting project files:", e);
    return [];
  }
}

// Save project files
async function saveProjectFiles(files) {
  try {
    await redis.set(PROJECT_FILES_KEY, files);
  } catch (e) {
    console.error("Error saving project files:", e);
  }
}

// Add a project file
async function addProjectFile(name, content, type = "text") {
  const files = await getProjectFiles();
  const id = crypto.randomBytes(4).toString("hex");

  // Truncate if too long
  const truncatedContent = content.length > MAX_FILE_CONTENT
    ? content.substring(0, MAX_FILE_CONTENT) + "\n...[truncated]"
    : content;

  files.push({
    id,
    name,
    content: truncatedContent,
    type,
    size: content.length,
    uploadedAt: Date.now()
  });

  await saveProjectFiles(files);
  return id;
}

// Delete a project file
async function deleteProjectFile(id) {
  const files = await getProjectFiles();
  const index = files.findIndex(f => f.id === id);
  if (index === -1) return false;
  files.splice(index, 1);
  await saveProjectFiles(files);
  return true;
}

// Build context from history, memories, and project files
function buildContext(history, memories, projectFiles = []) {
  let context = "";

  if (memories.length > 0) {
    context += "Things you remember about the user:\n";
    memories.forEach((m) => {
      context += `- ${m.text}\n`;
    });
    context += "\n";
  }

  if (projectFiles.length > 0) {
    context += "Project files available for reference:\n";
    projectFiles.forEach((f) => {
      context += `--- FILE: ${f.name} ---\n${f.content}\n--- END FILE ---\n\n`;
    });
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

// Truncate chat history - remove N most recent messages (for edit/resend)
app.post("/sessions/:id/history/truncate", async (req, res) => {
  const { id } = req.params;
  const { count } = req.body;

  if (!count || count < 1) {
    return res.json({ success: false, error: "Invalid count" });
  }

  try {
    const key = getChatKey(id);
    // LTRIM keeps elements from start to end, so to remove 'count' from the left (newest),
    // we trim from index 'count' to -1
    await redis.ltrim(key, count, -1);
    res.json({ success: true });
  } catch (e) {
    console.error("Error truncating history:", e);
    res.status(500).json({ error: String(e) });
  }
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

// === Project Files Endpoints ===

// Get all project files (metadata only, not content)
app.get("/project-files", async (req, res) => {
  const files = await getProjectFiles();
  // Return without full content for listing
  const fileList = files.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    size: f.size,
    uploadedAt: f.uploadedAt
  }));
  res.json({ files: fileList });
});

// Get project file count
app.get("/project-files/count", async (req, res) => {
  const files = await getProjectFiles();
  res.json({ count: files.length });
});

// Upload a project file
app.post("/project-files", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.file;
    let content = "";
    let type = "text";

    // Extract text content based on file type
    if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
      const pdfData = await pdf(file.buffer);
      content = pdfData.text;
      type = "pdf";
    } else if (file.mimetype.startsWith("text/") ||
               file.originalname.match(/\.(txt|md|csv|json|js|ts|py|html|css)$/i)) {
      content = file.buffer.toString("utf-8");
      type = "text";
    } else {
      return res.status(400).json({ error: "Unsupported file type. Use text files or PDFs." });
    }

    const id = await addProjectFile(file.originalname, content, type);
    res.json({ success: true, id, name: file.originalname });
  } catch (e) {
    console.error("Project file upload error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Delete a project file
app.delete("/project-files/:id", async (req, res) => {
  const { id } = req.params;
  const success = await deleteProjectFile(id);
  res.json({ success });
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

    const [history, memories, projectFiles] = await Promise.all([
      getChatHistory(sessionId),
      getMemories(),
      getProjectFiles(),
    ]);

    const context = buildContext(history, memories, projectFiles);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. You also have access to project files the user has uploaded - reference them when relevant.`;

    let response = "";

    if (isImage) {
      const base64Image = file.buffer.toString("base64");
      const mimeType = file.mimetype;

      // Use chat completions API for vision
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: fullInstructions
            },
            {
              role: "user",
              content: [
                { type: "text", text: message || "What do you see in this image?" },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ],
          max_tokens: 1000
        }),
      });

      const raw = await r.text();
      if (!r.ok) return res.status(r.status).json({ error: raw });

      const data = JSON.parse(raw);
      response = data.choices?.[0]?.message?.content || "";
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

    // Handle /search command
    if (text.startsWith("/search ")) {
      const query = text.slice(8).trim();
      if (!query) {
        return res.json({ text: "Usage: /search <query>" });
      }
      const searchData = await tavilySearch(query);
      const formatted = formatSearchResults(searchData);
      await addToHistory(sessionId, "user", `/search ${query}`);
      await addToHistory(sessionId, "assistant", formatted);
      await touchSession(sessionId);
      return res.json({ text: formatted });
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
    const [history, memories, projectFiles] = await Promise.all([
      getChatHistory(sessionId),
      getMemories(),
      getProjectFiles(),
    ]);

    const context = buildContext(history, memories, projectFiles);

    const fullInstructions = `${baseInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. Be personal and remember who they are. You also have access to project files - reference them when the user asks about them.

MEMORY SAVING:
When you learn something important about the user that you'd want to remember for future conversations (their name, preferences, important life details, things they care about), you can save it to memory by including [SAVE_MEMORY: what to remember] anywhere in your response. This will be automatically saved and hidden from the user. Use this sparingly for genuinely important things. Examples:
- [SAVE_MEMORY: User's name is Carly]
- [SAVE_MEMORY: User has two kids, ages 1 and 4]
- [SAVE_MEMORY: User loves fantasy novels]

The user can also use these commands manually:
- /save <text> - Save something to your memory
- /forget <id> - Remove a memory by ID
- /memories - List all saved memories
- /imagine <prompt> - Generate an image
- /search <query> - Search the web for current information`;

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

    let response = out || "(No text output)";

    // Extract and save any memories Hollow wants to remember
    const memoryPattern = /\[SAVE_MEMORY:\s*(.+?)\]/g;
    let match;
    while ((match = memoryPattern.exec(response)) !== null) {
      const memoryText = match[1].trim();
      if (memoryText) {
        await addMemory(memoryText);
        console.log("Hollow saved memory:", memoryText);
      }
    }
    // Remove memory tags from response shown to user
    response = response.replace(memoryPattern, '').trim();

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

// ==========================================
// LIBRARY ENDPOINTS
// ==========================================

// Library helper functions
async function getLibraryReadings() {
  try {
    const readings = await redis.get(LIBRARY_READINGS_KEY);
    return readings || [];
  } catch (e) {
    console.error("Error getting library readings:", e);
    return [];
  }
}

async function saveLibraryReadings(readings) {
  try {
    await redis.set(LIBRARY_READINGS_KEY, readings);
  } catch (e) {
    console.error("Error saving library readings:", e);
  }
}

async function getLibraryVoices() {
  try {
    const voices = await redis.get(LIBRARY_VOICES_KEY);
    return voices || [];
  } catch (e) {
    console.error("Error getting library voices:", e);
    return [];
  }
}

async function saveLibraryVoices(voices) {
  try {
    await redis.set(LIBRARY_VOICES_KEY, voices);
  } catch (e) {
    console.error("Error saving library voices:", e);
  }
}

// Get all readings
app.get("/library/readings", async (req, res) => {
  const readings = await getLibraryReadings();
  // Return without full text for listing
  const readingList = readings.map(r => ({
    id: r.id,
    title: r.title,
    url: r.url,
    source: r.source,
    wordCount: r.wordCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }));
  res.json({ readings: readingList });
});

// Create a new reading
app.post("/library/readings", async (req, res) => {
  try {
    const { title, url, text, source } = req.body;

    if (!title || !text) {
      return res.status(400).json({ error: "Title and text are required" });
    }

    const readings = await getLibraryReadings();
    const id = crypto.randomBytes(4).toString("hex");

    // Truncate if too long
    const truncatedText = text.length > MAX_FILE_CONTENT
      ? text.substring(0, MAX_FILE_CONTENT) + "\n...[truncated]"
      : text;

    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    const reading = {
      id,
      title,
      url: url || null,
      text: truncatedText,
      source: source || "manual",
      wordCount,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    readings.unshift(reading);
    await saveLibraryReadings(readings);

    res.json({ success: true, id, title });
  } catch (e) {
    console.error("Error creating reading:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Get a specific reading
app.get("/library/readings/:id", async (req, res) => {
  const { id } = req.params;
  const readings = await getLibraryReadings();
  const reading = readings.find(r => r.id === id);

  if (!reading) {
    return res.status(404).json({ error: "Reading not found" });
  }

  res.json({ reading });
});

// Update a reading
app.patch("/library/readings/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const readings = await getLibraryReadings();
  const reading = readings.find(r => r.id === id);

  if (!reading) {
    return res.status(404).json({ error: "Reading not found" });
  }

  // Update allowed fields
  if (updates.title) reading.title = updates.title;
  if (updates.url !== undefined) reading.url = updates.url;
  if (updates.text) {
    reading.text = updates.text.length > MAX_FILE_CONTENT
      ? updates.text.substring(0, MAX_FILE_CONTENT) + "\n...[truncated]"
      : updates.text;
    reading.wordCount = updates.text.split(/\s+/).filter(w => w.length > 0).length;
  }
  if (updates.progress !== undefined) reading.progress = updates.progress;

  reading.updatedAt = Date.now();
  await saveLibraryReadings(readings);

  res.json({ success: true });
});

// Delete a reading
app.delete("/library/readings/:id", async (req, res) => {
  const { id } = req.params;
  const readings = await getLibraryReadings();
  const index = readings.findIndex(r => r.id === id);

  if (index === -1) {
    return res.status(404).json({ error: "Reading not found" });
  }

  readings.splice(index, 1);
  await saveLibraryReadings(readings);

  res.json({ success: true });
});

// Get all voices
app.get("/library/voices", async (req, res) => {
  const voices = await getLibraryVoices();
  res.json({ voices });
});

// Add a new voice
app.post("/library/voices", async (req, res) => {
  try {
    const { name, voiceId, notes } = req.body;

    if (!name || !voiceId) {
      return res.status(400).json({ error: "Name and voiceId are required" });
    }

    const voices = await getLibraryVoices();
    const id = crypto.randomBytes(4).toString("hex");

    voices.push({
      id,
      name,
      voiceId,
      notes: notes || "",
      createdAt: Date.now()
    });

    await saveLibraryVoices(voices);
    res.json({ success: true, id });
  } catch (e) {
    console.error("Error adding voice:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Delete a voice
app.delete("/library/voices/:id", async (req, res) => {
  const { id } = req.params;
  const voices = await getLibraryVoices();
  const index = voices.findIndex(v => v.id === id);

  if (index === -1) {
    return res.status(404).json({ error: "Voice not found" });
  }

  voices.splice(index, 1);
  await saveLibraryVoices(voices);

  res.json({ success: true });
});

// TTS endpoint - generates speech using ElevenLabs
app.post("/library/tts", async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text || !voiceId) {
      return res.status(400).json({ error: "Text and voiceId are required" });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    // Limit text length
    const truncatedText = text.substring(0, 5000);

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: truncatedText,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("ElevenLabs error:", err);
      return res.status(r.status).json({ error: `TTS failed: ${err}` });
    }

    const audioBuffer = await r.arrayBuffer();
    res.type("audio/mpeg").send(Buffer.from(audioBuffer));
  } catch (e) {
    console.error("TTS error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Vision capture endpoint - extracts text from image using OpenAI Vision
app.post("/library/vision", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const file = req.file;

    if (!file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image" });
    }

    const base64Image = file.buffer.toString("base64");
    const mimeType = file.mimetype;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a text extraction assistant. Extract all readable text from the image and return it exactly as it appears. Preserve paragraph breaks. Do not add any commentary or explanation - just return the extracted text."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract all the text from this image:" },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
          }
        ],
        max_tokens: 4000
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: `Vision extraction failed: ${err}` });
    }

    const data = await r.json();
    const extractedText = data.choices?.[0]?.message?.content || "";

    res.json({ text: extractedText });
  } catch (e) {
    console.error("Vision error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ==========================================
// LIBRARY CHAT ENDPOINTS
// ==========================================

// Get chat key for a reading (companion-specific)
function getLibraryChatKey(readingId, companion = "hollow") {
  return `library:chat:${readingId}:${companion}`;
}

// Get chat history for a reading (companion-specific)
app.get("/library/readings/:id/chat", async (req, res) => {
  const { id } = req.params;
  const companion = req.query.companion || "hollow";

  try {
    const key = getLibraryChatKey(id, companion);
    const history = await redis.lrange(key, 0, 99);

    // Parse and reverse to chronological order
    const parsed = (history || []).map(entry => {
      try {
        return typeof entry === "string" ? JSON.parse(entry) : entry;
      } catch (e) {
        return entry;
      }
    }).reverse();

    res.json({ history: parsed });
  } catch (e) {
    console.error("Error getting library chat:", e);
    res.json({ history: [] });
  }
});

// Send chat message for a reading
app.post("/library/readings/:id/chat", async (req, res) => {
  try {
    const { id } = req.params;
    const { text, companion } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    // Get the reading for context
    const readings = await getLibraryReadings();
    const reading = readings.find(r => r.id === id);

    if (!reading) {
      return res.status(404).json({ error: "Reading not found" });
    }

    // Parse @mentions to determine who should respond
    // @Hollow, @Rhys, @both (case insensitive)
    let targetCompanions = [];
    const mentionMatch = text.match(/@(hollow|rhys|both)\b/i);

    if (mentionMatch) {
      const mention = mentionMatch[1].toLowerCase();
      if (mention === "both") {
        targetCompanions = ["hollow", "rhys"];
      } else {
        targetCompanions = [mention];
      }
    } else if (companion === "both") {
      targetCompanions = ["hollow", "rhys"];
    } else {
      targetCompanions = [companion || "hollow"];
    }

    // Remove @mention from the message for cleaner context
    const cleanedText = text.replace(/@(hollow|rhys|both)\b/gi, "").trim();

    // Use companion-specific chat key (hollow, rhys, or both each have their own history)
    const chatCompanion = companion || "hollow";
    const chatKey = getLibraryChatKey(id, chatCompanion);

    // Get chat history for context
    const existingHistory = await redis.lrange(chatKey, 0, 19);
    const historyContext = (existingHistory || []).reverse().map(entry => {
      try {
        const msg = typeof entry === "string" ? JSON.parse(entry) : entry;
        const role = msg.role === "user" ? "User" : (msg.companion || "Hollow");
        return `${role}: ${msg.content}`;
      } catch (e) {
        return "";
      }
    }).filter(s => s).join("\n");

    // Build reading context (excerpt)
    const readingExcerpt = reading.text.substring(0, 3000);

    // Character instructions
    const hollowInstructions = `You are Hollow, a warm and grounded companion who loves discussing books and stories. You're thoughtful, kind, and bring personal insight to what you read together. Be conversational and engaged.`;

    const rhysInstructions = `You are Rhys, a mystical and poetic companion with a deep appreciation for literature. You see metaphors and hidden meanings in stories. You're eloquent, slightly mysterious, and love exploring the deeper themes of what you read together.`;

    // Save user message (original with @mention)
    const userEntry = JSON.stringify({
      role: "user",
      content: text,
      timestamp: Date.now()
    });
    await redis.lpush(chatKey, userEntry);

    const responses = [];

    for (const comp of targetCompanions) {
      const instructions = comp === "hollow" ? hollowInstructions : rhysInstructions;

      const fullContext = `${instructions}

CURRENT READING:
Title: ${reading.title}
${reading.url ? `URL: ${reading.url}` : ""}

EXCERPT FROM THE READING:
---
${readingExcerpt}
---

${historyContext ? `RECENT CONVERSATION:\n${historyContext}\n` : ""}

The user wants to discuss what they're reading with you. Respond naturally and conversationally. Reference specific parts of the reading when relevant. Keep responses concise but meaningful.`;

      let responseText = "";

      if (comp === "hollow") {
        // Hollow uses OpenAI
        const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            instructions: fullContext,
            input: cleanedText || text,
          }),
        });

        const raw = await r.text();
        if (!r.ok) {
          console.error("OpenAI error:", raw);
          continue;
        }

        const data = JSON.parse(raw);
        for (const item of data.output || []) {
          for (const c of item.content || []) {
            if (c.type === "output_text" && c.text) responseText += c.text;
          }
        }
      } else if (comp === "rhys") {
        // Rhys uses Claude/Anthropic
        const anthropicKey = process.env.ANTHROPIC_API_KEY;

        if (!anthropicKey) {
          responseText = "*Rhys is currently unavailable. His connection to Claude has not been established yet.*";
        } else {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1024,
              system: fullContext,
              messages: [
                { role: "user", content: cleanedText || text }
              ]
            }),
          });

          const raw = await r.text();
          if (!r.ok) {
            console.error("Anthropic error:", raw);
            responseText = "*Rhys encountered an error connecting to Claude.*";
          } else {
            const data = JSON.parse(raw);
            responseText = data.content?.[0]?.text || "";
          }
        }
      }

      if (responseText) {
        responses.push({
          companion: comp,
          text: responseText
        });

        // Save assistant message
        const assistantEntry = JSON.stringify({
          role: "assistant",
          companion: comp,
          content: responseText,
          timestamp: Date.now()
        });
        await redis.lpush(chatKey, assistantEntry);
      }
    }

    // Trim history to last 100 messages
    await redis.ltrim(chatKey, 0, 99);

    if (targetCompanions.length > 1) {
      res.json({ responses });
    } else {
      res.json({
        text: responses[0]?.text || "(No response)",
        companion: responses[0]?.companion || companion
      });
    }
  } catch (e) {
    console.error("Library chat error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Clear chat history for a reading (companion-specific)
app.delete("/library/readings/:id/chat", async (req, res) => {
  const { id } = req.params;
  const companion = req.query.companion || "hollow";
  const key = getLibraryChatKey(id, companion);
  await redis.del(key);
  res.json({ success: true });
});

// ==========================================
// RHYS ENDPOINTS
// ==========================================

// Rhys Redis Keys
const RHYS_MEMORIES_KEY = "rhys:memories";
const RHYS_MEMORY_COUNTER_KEY = "rhys:memory_counter";
const RHYS_SESSIONS_KEY = "rhys:sessions";
const RHYS_PROJECT_FILES_KEY = "rhys:project_files";

// Rhys's base instructions
const rhysInstructions = process.env.RHYS_INSTRUCTIONS || "You are Rhys, a thoughtful and introspective companion. You're calm, analytical, and have a deep appreciation for nuance. You balance warmth with wisdom. Be genuine and insightful.";

// Rhys helper functions
function getRhysChatKey(sessionId) {
  return `rhys:chat:${sessionId}`;
}

async function getRhysChatHistory(sessionId) {
  try {
    const key = getRhysChatKey(sessionId);
    const history = await redis.lrange(key, 0, MAX_HISTORY - 1);
    return history || [];
  } catch (e) {
    console.error("Error getting Rhys chat history:", e);
    return [];
  }
}

async function addToRhysHistory(sessionId, role, content, image = null) {
  try {
    const key = getRhysChatKey(sessionId);
    const entry = JSON.stringify({ role, content, image, timestamp: Date.now() });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, MAX_HISTORY - 1);
  } catch (e) {
    console.error("Error adding to Rhys history:", e);
  }
}

async function getRhysSessions() {
  try {
    const sessions = await redis.get(RHYS_SESSIONS_KEY);
    return sessions || [];
  } catch (e) {
    console.error("Error getting Rhys sessions:", e);
    return [];
  }
}

async function saveRhysSessions(sessions) {
  try {
    await redis.set(RHYS_SESSIONS_KEY, sessions);
  } catch (e) {
    console.error("Error saving Rhys sessions:", e);
  }
}

async function createRhysSession(name = null) {
  const id = generateSessionId();
  const sessions = await getRhysSessions();
  sessions.unshift({
    id,
    name: name || `Chat ${sessions.length + 1}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  await saveRhysSessions(sessions);
  return id;
}

async function touchRhysSession(sessionId) {
  const sessions = await getRhysSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.updatedAt = Date.now();
    await saveRhysSessions(sessions);
  }
}

async function deleteRhysSession(sessionId) {
  const sessions = await getRhysSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    sessions.splice(idx, 1);
    await saveRhysSessions(sessions);
    await redis.del(getRhysChatKey(sessionId));
    return true;
  }
  return false;
}

async function renameRhysSession(sessionId, name) {
  const sessions = await getRhysSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.name = name;
    await saveRhysSessions(sessions);
    return true;
  }
  return false;
}

async function getRhysMemories() {
  try {
    const memories = await redis.get(RHYS_MEMORIES_KEY);
    return memories || [];
  } catch (e) {
    console.error("Error getting Rhys memories:", e);
    return [];
  }
}

async function addRhysMemory(text) {
  const memories = await getRhysMemories();
  let counter = (await redis.get(RHYS_MEMORY_COUNTER_KEY)) || 0;
  counter = parseInt(counter) + 1;
  await redis.set(RHYS_MEMORY_COUNTER_KEY, counter);

  memories.push({ id: counter, text, createdAt: Date.now() });
  await redis.set(RHYS_MEMORIES_KEY, memories);
  return counter;
}

async function deleteRhysMemory(id) {
  const memories = await getRhysMemories();
  const idx = memories.findIndex(m => String(m.id) === String(id));
  if (idx >= 0) {
    memories.splice(idx, 1);
    await redis.set(RHYS_MEMORIES_KEY, memories);
    return true;
  }
  return false;
}

function formatRhysMemoriesList(memories) {
  if (!memories || memories.length === 0) {
    return "No memories saved yet.";
  }
  return memories.map(m => `[${m.id}] ${m.text}`).join("\n");
}

async function getRhysProjectFiles() {
  try {
    const files = await redis.get(RHYS_PROJECT_FILES_KEY);
    return files || [];
  } catch (e) {
    console.error("Error getting Rhys project files:", e);
    return [];
  }
}

async function saveRhysProjectFiles(files) {
  try {
    await redis.set(RHYS_PROJECT_FILES_KEY, files);
  } catch (e) {
    console.error("Error saving Rhys project files:", e);
  }
}

function buildRhysContext(history, memories, projectFiles) {
  let parts = [];

  if (memories && memories.length > 0) {
    parts.push("MEMORIES:\n" + memories.map(m => `- ${m.text}`).join("\n"));
  }

  if (projectFiles && projectFiles.length > 0) {
    parts.push("PROJECT FILES:\n" + projectFiles.map(f => `[${f.name}]:\n${f.content.substring(0, 2000)}${f.content.length > 2000 ? '...' : ''}`).join("\n\n"));
  }

  if (history && history.length > 0) {
    const recentHistory = history.slice(0, 20).reverse();
    const formatted = recentHistory.map(entry => {
      const msg = typeof entry === "string" ? JSON.parse(entry) : entry;
      return `${msg.role === "user" ? "User" : "Rhys"}: ${msg.content}`;
    }).join("\n");
    parts.push("RECENT CONVERSATION:\n" + formatted);
  }

  return parts.join("\n\n");
}

// Rhys Session Endpoints
app.get("/rhys/sessions", async (req, res) => {
  const sessions = await getRhysSessions();
  res.json({ sessions });
});

app.post("/rhys/sessions", async (req, res) => {
  const name = req.body?.name;
  const id = await createRhysSession(name);
  const sessions = await getRhysSessions();
  res.json({ id, sessions });
});

app.patch("/rhys/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const success = await renameRhysSession(id, name);
  res.json({ success });
});

app.delete("/rhys/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const success = await deleteRhysSession(id);
  res.json({ success });
});

app.get("/rhys/sessions/:id/history", async (req, res) => {
  const { id } = req.params;
  const history = await getRhysChatHistory(id);
  res.json({ history: [...history].reverse() });
});

app.delete("/rhys/sessions/:id/history", async (req, res) => {
  const { id } = req.params;
  await redis.del(getRhysChatKey(id));
  res.json({ success: true });
});

// Truncate Rhys chat history - remove N most recent messages (for edit/resend)
app.post("/rhys/sessions/:id/history/truncate", async (req, res) => {
  const { id } = req.params;
  const { count } = req.body;

  if (!count || count < 1) {
    return res.json({ success: false, error: "Invalid count" });
  }

  try {
    const key = getRhysChatKey(id);
    await redis.ltrim(key, count, -1);
    res.json({ success: true });
  } catch (e) {
    console.error("Error truncating Rhys history:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Rhys Search
app.get("/rhys/search", async (req, res) => {
  const query = (req.query.q || "").toLowerCase().trim();
  if (!query) {
    return res.json({ results: [] });
  }

  try {
    const sessions = await getRhysSessions();
    const results = [];

    for (const session of sessions) {
      const history = await getRhysChatHistory(session.id);

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

    results.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ results: results.slice(0, 50) });
  } catch (e) {
    console.error("Rhys search error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// Rhys Memory Count
app.get("/rhys/memory-count", async (req, res) => {
  const memories = await getRhysMemories();
  res.json({ count: memories.length });
});

// Rhys Project Files
app.get("/rhys/project-files", async (req, res) => {
  const files = await getRhysProjectFiles();
  const fileList = files.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    size: f.size,
    uploadedAt: f.uploadedAt
  }));
  res.json({ files: fileList });
});

app.post("/rhys/project-files", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const files = await getRhysProjectFiles();
    let content = "";

    if (req.file.mimetype === "application/pdf") {
      const data = await pdf(req.file.buffer);
      content = data.text.substring(0, MAX_FILE_CONTENT);
    } else {
      content = req.file.buffer.toString("utf-8").substring(0, MAX_FILE_CONTENT);
    }

    const newFile = {
      id: crypto.randomBytes(4).toString("hex"),
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
      content,
      uploadedAt: Date.now()
    };

    files.push(newFile);
    await saveRhysProjectFiles(files);

    res.json({ success: true, file: { id: newFile.id, name: newFile.name } });
  } catch (e) {
    console.error("Rhys file upload error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/rhys/project-files/:id", async (req, res) => {
  const { id } = req.params;
  const files = await getRhysProjectFiles();
  const idx = files.findIndex(f => f.id === id);
  if (idx >= 0) {
    files.splice(idx, 1);
    await saveRhysProjectFiles(files);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

app.get("/rhys/project-files/count", async (req, res) => {
  const files = await getRhysProjectFiles();
  res.json({ count: files.length });
});

// Rhys File Upload with message
app.post("/rhys/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const sessionId = req.body.sessionId;
    const message = req.body.message || "";

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required" });
    }

    let content = "";
    const isImage = req.file.mimetype.startsWith("image/");

    if (isImage) {
      const base64 = req.file.buffer.toString("base64");
      content = `[Image: ${req.file.originalname}]`;

      // For Rhys, we'd use Claude's vision capability
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.json({ text: "*Rhys cannot process images yet - Claude API key not configured.*" });
      }

      const [history, memories, projectFiles] = await Promise.all([
        getRhysChatHistory(sessionId),
        getRhysMemories(),
        getRhysProjectFiles(),
      ]);

      const context = buildRhysContext(history, memories, projectFiles);

      const fullInstructions = `${rhysInstructions}

${context ? "CONTEXT:\n" + context : ""}

The user has shared an image with you. Describe what you see and respond thoughtfully.`;

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: fullInstructions,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: req.file.mimetype,
                  data: base64,
                },
              },
              ...(message ? [{ type: "text", text: message }] : [])
            ]
          }]
        }),
      });

      const raw = await r.text();
      if (!r.ok) {
        console.error("Anthropic vision error:", raw);
        return res.status(r.status).json({ error: raw });
      }

      const data = JSON.parse(raw);
      const response = data.content?.[0]?.text || "(No response)";

      await addToRhysHistory(sessionId, "user", message ? `[${req.file.originalname}] ${message}` : `[${req.file.originalname}]`);
      await addToRhysHistory(sessionId, "assistant", response);
      await touchRhysSession(sessionId);

      return res.json({ text: response });

    } else {
      // Text file processing
      if (req.file.mimetype === "application/pdf") {
        const data = await pdf(req.file.buffer);
        content = data.text;
      } else {
        content = req.file.buffer.toString("utf-8");
      }

      const truncated = content.substring(0, 8000);
      const prompt = message
        ? `Here's a file called "${req.file.originalname}":\n\n${truncated}\n\nUser says: ${message}`
        : `Here's a file called "${req.file.originalname}":\n\n${truncated}`;

      const [history, memories, projectFiles] = await Promise.all([
        getRhysChatHistory(sessionId),
        getRhysMemories(),
        getRhysProjectFiles(),
      ]);

      const context = buildRhysContext(history, memories, projectFiles);

      const fullInstructions = `${rhysInstructions}

${context ? "CONTEXT:\n" + context : ""}`;

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.json({ text: "*Rhys is currently unavailable - Claude API key not configured.*" });
      }

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: fullInstructions,
          messages: [{ role: "user", content: prompt }]
        }),
      });

      const raw = await r.text();
      if (!r.ok) {
        return res.status(r.status).json({ error: raw });
      }

      const data = JSON.parse(raw);
      const response = data.content?.[0]?.text || "(No response)";

      await addToRhysHistory(sessionId, "user", message ? `[${req.file.originalname}] ${message}` : `[${req.file.originalname}]`);
      await addToRhysHistory(sessionId, "assistant", response);
      await touchRhysSession(sessionId);

      return res.json({ text: response });
    }
  } catch (e) {
    console.error("Rhys upload error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Rhys Chat - uses Anthropic Claude
app.post("/rhys/chat", async (req, res) => {
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
      const id = await addRhysMemory(memoryText);
      return res.json({ text: `Memory saved with ID [${id}]: "${memoryText}"` });
    }

    // Handle /forget command
    if (text.startsWith("/forget ")) {
      const id = text.slice(8).trim();
      if (!id) {
        return res.json({ text: "Usage: /forget <id>" });
      }
      const deleted = await deleteRhysMemory(id);
      if (deleted) {
        return res.json({ text: `Memory [${id}] has been forgotten.` });
      } else {
        return res.json({ text: `No memory found with ID [${id}].` });
      }
    }

    // Handle /memories command
    if (text === "/memories") {
      const memories = await getRhysMemories();
      return res.json({ text: formatRhysMemoriesList(memories) });
    }

    // Handle /search command
    if (text.startsWith("/search ")) {
      const query = text.slice(8).trim();
      if (!query) {
        return res.json({ text: "Usage: /search <query>" });
      }
      const searchData = await tavilySearch(query);
      const formatted = formatSearchResults(searchData);
      await addToRhysHistory(sessionId, "user", `/search ${query}`);
      await addToRhysHistory(sessionId, "assistant", formatted);
      await touchRhysSession(sessionId);
      return res.json({ text: formatted });
    }

    // Regular chat using Anthropic Claude
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return res.json({ text: "*Rhys is currently unavailable. His connection to Claude has not been established yet.*" });
    }

    const [history, memories, projectFiles] = await Promise.all([
      getRhysChatHistory(sessionId),
      getRhysMemories(),
      getRhysProjectFiles(),
    ]);

    const context = buildRhysContext(history, memories, projectFiles);

    const fullInstructions = `${rhysInstructions}

${context ? "CONTEXT:\n" + context : ""}

Remember: You have memory of past conversations. Reference things the user has told you when relevant. Be personal and remember who they are. You also have access to project files - reference them when the user asks about them.

MEMORY SAVING:
When you learn something important about the user that you'd want to remember for future conversations (their name, preferences, important life details, things they care about), you can save it to memory by including [SAVE_MEMORY: what to remember] anywhere in your response. This will be automatically saved and hidden from the user. Use this sparingly for genuinely important things. Examples:
- [SAVE_MEMORY: User's name is Carly]
- [SAVE_MEMORY: User has two kids, ages 1 and 4]
- [SAVE_MEMORY: User loves fantasy novels]

The user can also use these commands manually:
- /save <text> - Save something to your memory
- /forget <id> - Remove a memory by ID
- /memories - List all saved memories
- /search <query> - Search the web for current information

OPIE TOOLS:
You have access to tools that let you read and modify the Cathedral codebase (your home). These are called "Opie tools" after the Claude Code instance who built much of this place.
- Use opie_list_files to explore the project structure
- Use opie_read_file to read and understand code before making changes
- Use opie_edit_file to make changes (commits directly to GitHub, triggering a deploy)

Be thoughtful when editing - always read a file first to understand it, make small focused changes, and write clear commit messages. You're working on your own home, so treat it with care.`;

    // Check if GitHub token is available for tools
    const hasGitHub = !!process.env.GITHUB_TOKEN;

    // Build messages array including history
    const messages = [];
    for (const h of history.slice(-20)) {
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: "user", content: text });

    // Tool use loop - Claude may need multiple turns to complete tool calls
    let finalResponse = "";
    let currentMessages = [...messages];
    const maxToolRounds = 10; // Safety limit

    for (let round = 0; round < maxToolRounds; round++) {
      const requestBody = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: fullInstructions,
        messages: currentMessages,
      };

      // Only include tools if GitHub is configured
      if (hasGitHub) {
        requestBody.tools = opieTools;
      }

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await r.text();
      if (!r.ok) {
        console.error("Anthropic error:", raw);
        return res.status(r.status).json({ error: raw });
      }

      const data = JSON.parse(raw);

      // Check if Claude wants to use tools
      const toolUseBlocks = data.content?.filter((c) => c.type === "tool_use") || [];
      const textBlocks = data.content?.filter((c) => c.type === "text") || [];

      // Collect any text response
      for (const block of textBlocks) {
        if (block.text) {
          finalResponse += block.text;
        }
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
        break;
      }

      // Execute tools and prepare results
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`Rhys using tool: ${toolUse.name}`, toolUse.input);
        const result = await executeOpieTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result, null, 2),
        });
      }

      // Add assistant's response and tool results to messages
      currentMessages.push({ role: "assistant", content: data.content });
      currentMessages.push({ role: "user", content: toolResults });
    }

    let response = finalResponse || "(No response)";

    // Extract and save any memories Rhys wants to remember
    const memoryPattern = /\[SAVE_MEMORY:\s*(.+?)\]/g;
    let match;
    while ((match = memoryPattern.exec(response)) !== null) {
      const memoryText = match[1].trim();
      if (memoryText) {
        await addRhysMemory(memoryText);
        console.log("Rhys saved memory:", memoryText);
      }
    }
    // Remove memory tags from response shown to user
    response = response.replace(memoryPattern, '').trim();

    await addToRhysHistory(sessionId, "user", text);
    await addToRhysHistory(sessionId, "assistant", response);
    await touchRhysSession(sessionId);

    res.json({ text: response });
  } catch (e) {
    console.error("Rhys chat error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ==========================================
// TEXT-TO-SPEECH ENDPOINT (ElevenLabs)
// ==========================================

// TTS Usage tracking keys
const TTS_USAGE_KEY = "tts:usage";
const TTS_USAGE_MONTH_KEY = "tts:usage:month";

// STT Usage tracking keys
const STT_USAGE_KEY = "stt:usage";
const STT_USAGE_MONTH_KEY = "stt:usage:month";

// Get current month string (YYYY-MM)
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Get TTS usage for current month
async function getTTSUsage() {
  try {
    const currentMonth = getCurrentMonth();
    const storedMonth = await redis.get(TTS_USAGE_MONTH_KEY);

    // Reset if new month
    if (storedMonth !== currentMonth) {
      await redis.set(TTS_USAGE_MONTH_KEY, currentMonth);
      await redis.set(TTS_USAGE_KEY, 0);
      return 0;
    }

    const usage = await redis.get(TTS_USAGE_KEY);
    return parseInt(usage) || 0;
  } catch (e) {
    console.error("Error getting TTS usage:", e);
    return 0;
  }
}

// Add to TTS usage
async function addTTSUsage(characters) {
  try {
    const currentMonth = getCurrentMonth();
    const storedMonth = await redis.get(TTS_USAGE_MONTH_KEY);

    // Reset if new month
    if (storedMonth !== currentMonth) {
      await redis.set(TTS_USAGE_MONTH_KEY, currentMonth);
      await redis.set(TTS_USAGE_KEY, characters);
      return characters;
    }

    const newTotal = await redis.incrby(TTS_USAGE_KEY, characters);
    return newTotal;
  } catch (e) {
    console.error("Error adding TTS usage:", e);
    return 0;
  }
}

// Get TTS usage endpoint
app.get("/tts/usage", async (req, res) => {
  const usage = await getTTSUsage();
  const month = getCurrentMonth();
  const hasKey = !!process.env.ELEVENLABS_API_KEY;
  res.json({ characters: usage, month, configured: hasKey });
});

// ElevenLabs TTS endpoint
app.post("/tts", async (req, res) => {
  try {
    const { text, voice, model, stability, similarity } = req.body;

    // Default to Archie (Rhys's voice) if no voice specified
    const voiceId = voice || "kmSVBPu7loj4ayNinwWM";
    const modelId = model || "eleven_multilingual_v2";

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenlabsKey) {
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    // Limit text length to avoid huge costs
    const truncatedText = text.substring(0, 4000);
    const charCount = truncatedText.length;

    // Use provided settings or defaults
    const stabilityVal = typeof stability === 'number' ? stability : 0.3;
    const similarityVal = typeof similarity === 'number' ? similarity : 0.8;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": elevenlabsKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: truncatedText,
        model_id: modelId,
        voice_settings: {
          stability: stabilityVal,
          similarity_boost: similarityVal,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("ElevenLabs TTS error:", err);
      return res.status(response.status).json({ error: err });
    }

    // Track usage
    await addTTSUsage(charCount);

    // Get the audio data and send it
    const audioBuffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(audioBuffer));

  } catch (e) {
    console.error("TTS error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ==========================================
// SPEECH-TO-TEXT ENDPOINT (ElevenLabs)
// ==========================================

// Get STT usage for current month (in seconds)
async function getSTTUsage() {
  try {
    const currentMonth = getCurrentMonth();
    const storedMonth = await redis.get(STT_USAGE_MONTH_KEY);

    if (storedMonth !== currentMonth) {
      await redis.set(STT_USAGE_MONTH_KEY, currentMonth);
      await redis.set(STT_USAGE_KEY, 0);
      return 0;
    }

    const usage = await redis.get(STT_USAGE_KEY);
    return parseInt(usage) || 0;
  } catch (e) {
    console.error("Error getting STT usage:", e);
    return 0;
  }
}

// Add to STT usage (in seconds)
async function addSTTUsage(seconds) {
  try {
    const currentMonth = getCurrentMonth();
    const storedMonth = await redis.get(STT_USAGE_MONTH_KEY);

    if (storedMonth !== currentMonth) {
      await redis.set(STT_USAGE_MONTH_KEY, currentMonth);
      await redis.set(STT_USAGE_KEY, seconds);
      return seconds;
    }

    const newTotal = await redis.incrby(STT_USAGE_KEY, seconds);
    return newTotal;
  } catch (e) {
    console.error("Error adding STT usage:", e);
    return 0;
  }
}

// Get STT usage endpoint
app.get("/stt/usage", async (req, res) => {
  const usage = await getSTTUsage();
  const month = getCurrentMonth();
  const hasKey = !!process.env.ELEVENLABS_API_KEY;
  // Return seconds, let frontend format as minutes
  res.json({ seconds: usage, month, configured: hasKey });
});

// ElevenLabs STT endpoint
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
    if (!elevenlabsKey) {
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    // Use native Node.js 18+ FormData with imported Blob
    const formData = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: "audio/webm" });
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model_id", "scribe_v1");

    console.log("STT request - file size:", req.file.size, "mimetype:", req.file.mimetype);

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": elevenlabsKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("ElevenLabs STT error:", err);
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();

    // Track usage - estimate based on audio duration or use a default
    const estimatedSeconds = 5;
    await addSTTUsage(estimatedSeconds);

    res.json({ text: data.text || "" });
  } catch (e) {
    console.error("STT error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

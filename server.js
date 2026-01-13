import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the tiny browser client
app.use(express.static("public"));

// Parse JSON bodies for /chat
app.use(express.json());

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// Basic session configuration for the Realtime API (WebRTC unified interface).
// You can adjust model/voice here.
const sessionConfig = JSON.stringify({
  type: "realtime",
  model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  audio: { output: { voice: process.env.OPENAI_VOICE || "echo" } },
  // Optional: set default instructions for the agent.
  // Keep these modest; you can also update them client-side via events if you want.
  instructions: process.env.AGENT_INSTRUCTIONS || "You are a warm, grounded voice companion. Be concise, kind, and helpful."
});

app.post("/chat", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.json({ text: "" });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
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

    res.json({ text: out || "(No text output)" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

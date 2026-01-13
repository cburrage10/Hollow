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

app.post("/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).send("Missing OPENAI_API_KEY on server.");
  }
  try {
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", sessionConfig);

    const r = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: fd,
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).send(errText);
    }

    // Send back the SDP we received from the OpenAI REST API
    const sdp = await r.text();
    res.type("application/sdp").send(sdp);
  } catch (error) {
    console.error(error);
    res.status(500).send(String(error));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

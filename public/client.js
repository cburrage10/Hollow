// WebRTC client for OpenAI Realtime API with transcription support
const statusEl = document.getElementById("status");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");

let pc = null;
let localStream = null;
let dataChannel = null;

function setStatus(msg, connected = false) {
  statusEl.textContent = msg;
  statusEl.className = connected ? 'connected' : '';
}

// Helper to add messages to chat (reuse the function from main page)
function addVoiceMessage(text, isUser) {
  if (typeof window.addMessage === 'function') {
    window.addMessage(text, isUser);
  } else {
    console.log(`${isUser ? 'You' : 'Hollow'}: ${text}`);
  }
}

async function connect() {
  btnConnect.disabled = true;
  setStatus("Requesting microphone…");

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  setStatus("Creating peer connection…");
  pc = new RTCPeerConnection();

  // Play remote audio from the model
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (event) => {
    audioEl.srcObject = event.streams[0];
  };

  // Send mic tracks
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // Create data channel for events (must be created before offer)
  dataChannel = pc.createDataChannel("oai-events");

  let currentTranscript = "";
  let userTranscript = "";

  dataChannel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // User speech transcription completed
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript?.trim();
        if (transcript) {
          addVoiceMessage(transcript, true);
        }
      }

      // Hollow's response transcription (streaming)
      if (msg.type === "response.audio_transcript.delta") {
        currentTranscript += msg.delta || "";
      }

      // Hollow's response transcription complete
      if (msg.type === "response.audio_transcript.done") {
        const transcript = msg.transcript?.trim() || currentTranscript.trim();
        if (transcript) {
          addVoiceMessage(transcript, false);
        }
        currentTranscript = "";
      }

      // Handle errors
      if (msg.type === "error") {
        console.error("Realtime API error:", msg.error);
        setStatus("Error: " + (msg.error?.message || "Unknown error"));
      }

    } catch (e) {
      console.error("Failed to parse data channel message:", e);
    }
  };

  dataChannel.onopen = () => {
    console.log("Data channel opened");
    // Request input audio transcription
    dataChannel.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_transcription: {
          model: "whisper-1"
        }
      }
    }));
  };

  dataChannel.onclose = () => {
    console.log("Data channel closed");
  };

  // Create offer SDP
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  setStatus("Creating Realtime session…");

  // POST SDP to our server; server forwards to OpenAI and returns remote SDP answer
  const resp = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Session error (${resp.status}): ${err}`);
  }

  const answerSdp = await resp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  btnDisconnect.disabled = false;
  setStatus("Connected - Speak to Hollow", true);
}

async function disconnect() {
  btnDisconnect.disabled = true;

  try {
    if (dataChannel) {
      dataChannel.close();
    }
    dataChannel = null;

    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
    }
    localStream = null;

    if (pc) {
      pc.getSenders().forEach(s => s.track && s.track.stop());
      pc.close();
    }
    pc = null;
  } finally {
    btnConnect.disabled = false;
    setStatus("Disconnected");
  }
}

btnConnect.addEventListener("click", async () => {
  try {
    await connect();
  } catch (e) {
    console.error(e);
    setStatus(String(e.message || e));
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
  }
});

btnDisconnect.addEventListener("click", () => disconnect());

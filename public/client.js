// Minimal WebRTC client that POSTs local SDP to /session and receives remote SDP back.
// Based on the OpenAI Realtime WebRTC guide (unified interface).
const statusEl = document.getElementById("status");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");

let pc = null;
let localStream = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function connect() {
  btnConnect.disabled = true;
  setStatus("Requesting microphone…");

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  setStatus("Creating peer connection…");
  pc = new RTCPeerConnection();

  // Play remote audio from the model.
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (event) => {
    audioEl.srcObject = event.streams[0];
  };

  // Send mic tracks.
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // Create offer SDP
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  setStatus("Creating Realtime session…");

  // POST SDP to our server; server forwards to OpenAI and returns remote SDP answer.
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
  setStatus("Connected. Speak normally.");
}

async function disconnect() {
  btnDisconnect.disabled = true;

  try {
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
    setStatus("Disconnected.");
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

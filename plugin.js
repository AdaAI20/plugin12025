const PP = window.parent;
let latestPng = null;

const statusEl = document.getElementById('status');
const apiKeyEl = document.getElementById('apiKey');
const promptEl = document.getElementById('prompt');
const countEl  = document.getElementById('count');

function setStatus(t) { statusEl.textContent = t; }

window.addEventListener('message', (e) => {
  const data = e.data;
  if (data === 'done') return;
  if (data instanceof ArrayBuffer) {
    latestPng = data;
    setStatus('Got canvas PNG from Photopea');
  } else if (typeof data === 'string') {
    console.log('PP says:', data);
  }
});

document.getElementById('export').onclick = () => {
  setStatus('Exporting canvas...');
  PP.postMessage('app.activeDocument.saveToOE("png");', '*');
};

document.getElementById('generate').onclick = async () => {
  try {
    const apiKey = apiKeyEl.value.trim();
    if (!apiKey) { setStatus('Enter GEMINI_API_KEY'); return; }
    if (!latestPng) { setStatus('Export the canvas first'); return; }

    const count = Math.max(1, Math.min(6, parseInt(countEl.value || '1', 10)));
    setStatus(`Contacting Gemini for ${count} image(s)...`);

    const b64 = arrayBufferToBase64(latestPng);

    for (let i = 0; i < count; i++) {
      const outBuf = await generateOne(apiKey, promptEl.value || 'Enhance image', b64);
      PP.postMessage(outBuf, '*');
      setStatus(`Inserted image ${i + 1}/${count}`);
      // Gentle pacing for free-tier rate limits
      await delay(600);
    }

    setStatus(`Done: ${count} image(s) inserted`);
  } catch (err) {
    console.error(err);
    setStatus(err.message);
  }
};

async function generateOne(apiKey, prompt, inputB64) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: inputB64 } }
      ]
    }]
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inline_data && p.inline_data.data);
  if (!imgPart) throw new Error('No image in response');
  return base64ToArrayBuffer(imgPart.inline_data.data);
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
  return bytes.buffer;
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}
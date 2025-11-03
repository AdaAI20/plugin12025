const PP = window.parent;
let latestPng = null;

const statusEl      = document.getElementById('status');
const apiKeyEl      = document.getElementById('apiKey');
const promptEl      = document.getElementById('prompt');
const countEl       = document.getElementById('count');
const modelSelect   = document.getElementById('modelSelect');
const customModelEl = document.getElementById('customModel');
const refreshBtn    = document.getElementById('refreshModels');

function setStatus(t) { statusEl.textContent = t; }

const FALLBACK_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];

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

refreshBtn.onclick = async () => {
  const key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter GEMINI_API_KEY first'); return; }
  await loadModels(key);
};

document.getElementById('generate').onclick = async () => {
  try {
    const apiKey = apiKeyEl.value.trim();
    if (!apiKey) { setStatus('Enter GEMINI_API_KEY'); return; }
    if (!latestPng) { setStatus('Export the canvas first'); return; }

    const chosen = (customModelEl.value.trim() || modelSelect.value || "").trim();
    if (!chosen) { setStatus('Pick a model or enter a custom ID'); return; }

    const count = Math.max(1, Math.min(6, parseInt(countEl.value || '1', 10)));
    setStatus(`Calling ${chosen} for ${count} image(s)...`);

    const b64 = arrayBufferToBase64(latestPng);

    for (let i = 0; i < count; i++) {
      const outBuf = await generateOneWithBackoff(apiKey, chosen, promptEl.value || 'Enhance image', b64);
      PP.postMessage(outBuf, '*');
      setStatus(`Inserted image ${i + 1}/${count}`);
      await delay(6500); // be nice to free-tier RPM
    }

    setStatus(`Done: ${count} image(s) inserted`);
  } catch (err) {
    console.error(err);
    setStatus(err.message);
  }
};

async function loadModels(apiKey) {
  setStatus('Listing models...');
  modelSelect.innerHTML = '';
  let list = [];
  try {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey }
    });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`List models HTTP ${resp.status}: ${txt}`);
    const json = JSON.parse(txt || '{}');
    const arr = Array.isArray(json.models) ? json.models : [];
    list = arr
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map(m => (m.name || '').split('/').pop())
      .filter(Boolean);
  } catch (e) {
    console.warn('List models failed', e);
  }
  if (list.length === 0) {
    list = [...FALLBACK_MODELS];
    setStatus('Models endpoint returned none; using fallback list');
  }
  const seen = new Set();
  list.forEach(m => { if (!seen.has(m)) seen.add(m); });
  const unique = Array.from(seen).sort();
  unique.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    modelSelect.appendChild(opt);
  });
  setStatus(`Models ready (${unique.length})`);
}

async function generateOneWithBackoff(apiKey, modelId, prompt, inputB64) {
  let attempt = 0;
  while (true) {
    try {
      return await generateOne(apiKey, modelId, prompt, inputB64);
    } catch (e) {
      attempt++;
      const msg = String(e && e.message || '');
      if (msg.includes('HTTP 429')) {
        const delaySec = parseRetryDelaySeconds(msg) || 40;
        setStatus(`429 from ${modelId}, waiting ${delaySec}s before retry #${attempt}...`);
        await delay(delaySec * 1000);
        continue;
      }
      throw e;
    }
  }
}

async function generateOne(apiKey, modelId, prompt, inputB64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

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

  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${txt}`);

  const json = JSON.parse(txt);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inline_data && p.inline_data.data);
  if (!imgPart) throw new Error('No image in response (model might be text-only)');
  return base64ToArrayBuffer(imgPart.inline_data.data);
}

function parseRetryDelaySeconds(msg) {
  const m = msg.match(/\"retryDelay\"\s*:\s*\"(\d+)s\"/i);
  return m ? parseInt(m[1], 10) : null;
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

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

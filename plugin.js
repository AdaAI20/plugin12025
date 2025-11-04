// --- Photopea bridge ---
const PP = window.parent;
let latestPng = null;

const statusEl      = document.getElementById('status');
const providerEl    = document.getElementById('provider');
const apiKeyEl      = document.getElementById('apiKey');
const promptEl      = document.getElementById('prompt');
const countEl       = document.getElementById('count');
const modelSelect   = document.getElementById('modelSelect');
const customModelEl = document.getElementById('customModel');
const refreshBtn    = document.getElementById('refreshModels');

function setStatus(t) { statusEl.textContent = t; }

// Fallbacks if listing fails
const GOOGLE_FALLBACK_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
]; // Model IDs follow Google’s v1beta/models/{id} convention for generateContent. [web:293]

const OR_FALLBACK_MODELS = [
  "google/gemini-2.5-pro",
  "google/gemini-2.0-flash-001"
]; // OpenRouter uses provider/model ids and an OpenAI‑compatible API. [web:344][web:342]

const COMET_FALLBACK_MODELS = [
  "google/gemini-2.5-flash-image",
  "google/gemini-2.5-pro",
  "google/gemini-2.0-flash-001"
]; // CometAPI is also OpenAI‑compatible with similar model naming. [web:390][web:393]

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
  PP.postMessage('app.activeDocument.saveToOE("png");', '*'); // Exports PNG buffer to the plugin. [web:40]
};

refreshBtn.onclick = async () => {
  const key = apiKeyEl.value.trim();
  if (!key) { setStatus('Enter API key first'); return; }
  const provider = providerEl.value;
  if (provider === 'google') {
    await loadModelsGoogle(key);
  } else if (provider === 'openrouter') {
    await loadModelsOpenRouter();
  } else {
    await loadModelsComet();
  }
};

document.getElementById('generate').onclick = async () => {
  try {
    const apiKey  = apiKeyEl.value.trim();
    const provider= providerEl.value;
    if (!apiKey)   { setStatus('Enter API key'); return; }
    if (!latestPng){ setStatus('Export the canvas first'); return; }

    const chosen = (customModelEl.value.trim() || modelSelect.value || "").trim();
    if (!chosen) { setStatus('Pick a model or enter a custom ID'); return; }

    const count = Math.max(1, Math.min(6, parseInt(countEl.value || '1', 10)));
    setStatus(`Calling ${chosen} via ${provider} for ${count} image(s)...`);

    const b64 = arrayBufferToBase64(latestPng);

    for (let i = 0; i < count; i++) {
      let outBuf;
      if (provider === 'google') {
        outBuf = await generateGoogleWithBackoff(apiKey, chosen, promptEl.value || 'Enhance image', b64);
      } else if (provider === 'openrouter') {
        outBuf = await generateOpenRouter(apiKey, chosen, promptEl.value || 'Enhance image', b64);
      } else {
        outBuf = await generateComet(apiKey, chosen, promptEl.value || 'Enhance image', b64);
      }
      if (outBuf) {
        PP.postMessage(outBuf, '*'); // Insert the result as a new doc/layer. [web:40]
        setStatus(`Inserted image ${i + 1}/${count}`);
      }
      await delay(6500); // pacing helps free‑tier RPM and reduces 429s. [web:249]
    }

    setStatus(`Done: ${count} image(s) processed`);
  } catch (err) {
    console.error(err);
    setStatus(err.message);
  }
};

// --- Model listing ---

async function loadModelsGoogle(apiKey) {
  setStatus('Listing Google models...');
  modelSelect.innerHTML = '';
  let list = [];
  try {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey }
    }); // Google list‑models endpoint with API key header. [web:282]
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`List models HTTP ${resp.status}: ${txt}`);
    const json = JSON.parse(txt || '{}');
    const arr = Array.isArray(json.models) ? json.models : [];
    list = arr
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map(m => (m.name || '').split('/').pop())
      .filter(Boolean); // Keep models that support generateContent. [web:282][web:293]
  } catch (e) {
    console.warn('Google list models failed', e);
  }
  if (list.length === 0) {
    list = [...GOOGLE_FALLBACK_MODELS];
    setStatus('Models endpoint returned none; using Google fallback list');
  }
  fillModelSelect(list);
}

async function loadModelsOpenRouter() {
  setStatus('Listing OpenRouter models...');
  modelSelect.innerHTML = '';
  // Use curated fallback; OpenRouter is OpenAI‑compatible and exposes a catalog on the site. [web:344][web:342]
  fillModelSelect([...OR_FALLBACK_MODELS]);
}

async function loadModelsComet() {
  setStatus('Listing CometAPI models...');
  modelSelect.innerHTML = '';
  // Use curated fallback; CometAPI aggregates 500+ models behind an OpenAI‑style API. [web:390][web:393]
  fillModelSelect([...COMET_FALLBACK_MODELS]);
}

function fillModelSelect(list) {
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

// --- Google generate (inline image edit via generateContent) ---

async function generateGoogleWithBackoff(apiKey, modelId, prompt, inputB64) {
  let attempt = 0;
  while (true) {
    try {
      return await generateGoogle(apiKey, modelId, prompt, inputB64);
    } catch (e) {
      attempt++;
      const msg = String(e && e.message || '');
      if (msg.includes('HTTP 429')) {
        const delaySec = parseRetryDelaySeconds(msg) || 40;
        setStatus(`429 from ${modelId}, waiting ${delaySec}s before retry #${attempt}...`);
        await delay(delaySec * 1000); // Honor RetryInfo guidance on 429. [web:260]
        continue;
      }
      throw e;
    }
  }
}

async function generateGoogle(apiKey, modelId, prompt, inputB64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`; // Correct endpoint shape. [web:293]
  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: 'image/png', data: inputB64 } }
    ]}]
  }; // Inline image is the documented approach for image editing. [web:396]
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${txt}`);
  const json = JSON.parse(txt);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inline_data && p.inline_data.data);
  if (!imgPart) throw new Error('No image in response (model may be text‑only)');
  return base64ToArrayBuffer(imgPart.inline_data.data);
}

// --- OpenRouter generate (OpenAI‑compatible Responses) ---

async function generateOpenRouter(apiKey, modelId, prompt, inputB64) {
  const url = 'https://openrouter.ai/api/v1/responses'; // OpenRouter base + responses endpoint. [web:344][web:347]
  const body = {
    model: modelId, // e.g., "google/gemini-2.5-pro" or another supported id. [web:342]
    input: [{
      role: 'user',
      content: [
        { type: 'input_text',  text: prompt },
        { type: 'input_image', image_url: `data:image/png;base64,${inputB64}` }
      ]
    }]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`, // OpenRouter uses Bearer auth. [web:344]
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${txt}`);
  const json = JSON.parse(txt);
  const out = json?.output || json?.choices?.[0]?.message?.content || '';
  const b64 = findBase64Image(out);
  if (!b64) throw new Error('No image returned by this model; try a different OpenRouter model id.');
  return base64ToArrayBuffer(b64);
}

// --- CometAPI generate (OpenAI‑compatible Responses) ---

async function generateComet(apiKey, modelId, prompt, inputB64) {
  const url = 'https://api.cometapi.com/v1/responses'; // CometAPI base + responses endpoint. [web:393]
  const body = {
    model: modelId, // e.g., "google/gemini-2.5-flash-image" on CometAPI. [web:390]
    input: [{
      role: 'user',
      content: [
        { type: 'input_text',  text: prompt },
        { type: 'input_image', image_url: `data:image/png;base64,${inputB64}` }
      ]
    }]
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`, // CometAPI uses Bearer auth. [web:393]
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`CometAPI HTTP ${resp.status}: ${txt}`);
  const json = JSON.parse(txt);
  const out = json?.output || json?.choices?.[0]?.message?.content || '';
  const b64 = findBase64Image(out);
  if (!b64) throw new Error('No image returned by this model; try another Comet model id.');
  return base64ToArrayBuffer(b64);
}

// --- Helpers ---

function findBase64Image(out) {
  if (!out) return null;
  if (typeof out === 'string') {
    const m = out.match(/data:image\/png;base64,([A-Za-z0-9+\/=]+)/);
    if (m) return m[1];
  } else if (Array.isArray(out)) {
    for (const item of out) {
      if (item && typeof item === 'object') {
        const url = item.image_url || item.url || '';
        if (typeof url === 'string') {
          const m = url.match(/data:image\/png;base64,([A-Za-z0-9+\/=]+)/);
          if (m) return m[1];
        }
        if (typeof item.text === 'string') {
          const m2 = item.text.match(/data:image\/png;base64,([A-Za-z0-9+\/=]+)/);
          if (m2) return m2[1];
        }
      }
    }
  }
  return null;
}

function parseRetryDelaySeconds(msg) {
  const m = msg.match(/\"retryDelay\"\s*:\s*\"(\d+)s\"/i);
  return m ? parseInt(m[1], 10) : null; // RetryInfo parsing for Google 429s. [web:260]
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

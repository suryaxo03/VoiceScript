/* ================================================================
   VOICESCRIPT — app.js
   Description: All app logic for the transcription tool.

   TABLE OF CONTENTS
   -----------------
   1.  DOM References
   2.  State
   3.  WebSocket Setup (graceful fallback)
   4.  Speech Recognition Setup
   5.  Start / Stop Recording
   6.  UI Helpers
   7.  Word & Character Count
   8.  Copy to Clipboard
   9.  Download Transcript
   10. Clear Transcripts
   11. Event Listeners
================================================================ */


/* ================================================================
   1. DOM REFERENCES
================================================================ */
const transcriptEl       = document.getElementById('transcript-display');
const transcriptEditor   = document.getElementById('transcript-editor');
const startBtn           = document.getElementById('start-btn');
const stopBtn            = document.getElementById('stop-btn');
const clearBtn           = document.getElementById('clear-btn');
const copyBtn            = document.getElementById('copy-btn');
const downloadBtn        = document.getElementById('download-btn');
const statusEl           = document.getElementById('status-indicator');
const langSelect         = document.getElementById('lang-select');
const recordingIndicator = document.getElementById('recording-indicator');
const recordingLangLabel = document.getElementById('recording-lang-label');
const liveWordCount      = document.getElementById('live-word-count');
const charCountEl        = document.getElementById('char-count');
const wordCountEl        = document.getElementById('word-count');
const wsDot              = document.querySelector('.status-dot');
const wsStatusText       = document.querySelector('.status-text');


/* ================================================================
   2. STATE
================================================================ */
let recognition  = null;   // SpeechRecognition instance
let isListening  = false;  // Whether recording is active
let finalBuffer  = "";     // Accumulates current final sentence
let ws           = null;   // WebSocket instance (may be null)
let wsConnected  = false;  // Whether WS is live


/* ================================================================
   3. WEBSOCKET SETUP (Graceful Fallback)

   The app works perfectly WITHOUT a backend server.
   We attempt to connect once. If it fails (e.g. on GitHub Pages
   where there's no server), we silently fall back to Offline Mode.
   Transcription continues 100% locally via the Web Speech API.

   If you have a backend at ws://localhost:3000, it will connect
   automatically and receive all final transcript segments.
================================================================ */
function initWebSocket() {
  try {
    ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
      wsConnected = true;
      setNavStatus('connected', 'Server Connected');
    };

    ws.onclose = () => {
      wsConnected = false;
      setNavStatus('disconnected', 'Offline Mode');
      ws = null;
    };

    ws.onerror = () => {
      // Expected when no backend is running — not alarming
      wsConnected = false;
      setNavStatus('disconnected', 'Offline Mode');
      ws = null;
    };

  } catch (err) {
    wsConnected = false;
    setNavStatus('disconnected', 'Offline Mode');
  }
}

/** Safely send over WebSocket — no-op if unavailable */
function wsSend(data) {
  if (ws && wsConnected && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

initWebSocket();


/* ================================================================
   4. SPEECH RECOGNITION SETUP
================================================================ */
function initRecognition() {
  const selectedLang = langSelect.value;

  if (!selectedLang) {
    setStatus('Please select a language before starting.');
    shakeElement(langSelect.closest('.lang-wrapper'));
    return false;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('Your browser does not support speech recognition. Please use Google Chrome or Microsoft Edge.');
    return false;
  }

  recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = selectedLang;

  // ── onresult ─────────────────────────────────────────────────
  recognition.onresult = (event) => {
    let interimText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;

      if (event.results[i].isFinal) {
        finalBuffer += transcript + ' ';

        if (finalBuffer.trim().length > 0) {
          removePlaceholder();

          const p = document.createElement('p');
          p.className   = 'final-line';
          p.textContent = finalBuffer.trim();
          transcriptEl.appendChild(p);
          finalBuffer = '';

          transcriptEl.scrollTop = transcriptEl.scrollHeight;
          updateLiveWordCount();

          wsSend({ action: 'transcript', text: p.textContent, isFinal: true });
        }
      } else {
        interimText += transcript;
      }
    }

    // Update or create the interim line
    const existingInterim = transcriptEl.querySelector('.interim-line');
    if (interimText) {
      if (existingInterim) {
        existingInterim.textContent = interimText;
      } else {
        removePlaceholder();
        const p = document.createElement('p');
        p.className   = 'interim-line';
        p.textContent = interimText;
        transcriptEl.appendChild(p);
      }
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    } else if (existingInterim) {
      existingInterim.remove();
    }
  };

  // ── onerror ──────────────────────────────────────────────────
  recognition.onerror = (event) => {
    if (event.error === 'no-speech') {
      setStatus('No speech detected. Still listening...');
      return;
    }
    if (event.error === 'aborted') return;
    if (event.error === 'language-not-supported') {
      setStatus('This language is not supported in your browser. Try Google Chrome for full language support.');
      stopRecognition();
      return;
    }
    setStatus(`Recognition error: ${event.error}. Please try again.`);
    stopRecognition();
  };

  // ── onend: auto-restart while still listening ─────────────────
  recognition.onend = () => {
    if (isListening) {
      try { recognition.start(); } catch (_) {}
    }
  };

  return true;
}


/* ================================================================
   5. START / STOP RECORDING
================================================================ */
function startRecognition() {
  if (isListening) return;
  if (!initRecognition()) return;

  recognition.start();
  isListening = true;

  startBtn.disabled = true;
  stopBtn.disabled  = false;

  recordingIndicator.classList.add('active');
  recordingLangLabel.textContent =
    langSelect.options[langSelect.selectedIndex].text;

  setNavStatus('recording', 'Recording');
  setStatus(`Recording in ${langSelect.options[langSelect.selectedIndex].text} — speak clearly into your microphone.`);
}

function stopRecognition() {
  if (!isListening) return;

  recognition.stop();
  isListening = false;

  startBtn.disabled = false;
  stopBtn.disabled  = true;

  recordingIndicator.classList.remove('active');

  setNavStatus(
    wsConnected ? 'connected' : 'disconnected',
    wsConnected ? 'Server Connected' : 'Offline Mode'
  );

  // Remove leftover interim lines
  transcriptEl.querySelectorAll('.interim-line').forEach(el => el.remove());

  // Compile all final lines into the editor
  let fullText = '';
  transcriptEl.querySelectorAll('.final-line').forEach(p => {
    fullText += p.textContent + '\n';
  });
  transcriptEditor.value = fullText.trim();

  updateEditorCount();
  setStatus('Recording stopped. You can edit the transcript on the right.');
}


/* ================================================================
   6. UI HELPERS
================================================================ */
function setNavStatus(state, text) {
  wsDot.className      = `status-dot ${state}`;
  wsStatusText.textContent = text;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function removePlaceholder() {
  const placeholder = transcriptEl.querySelector('.placeholder-wrap');
  if (placeholder) placeholder.remove();
}

/** Shake element using CSS animation class */
function shakeElement(el) {
  el.classList.remove('shake');
  // Force reflow so re-adding the class triggers the animation again
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

/** Show a brief toast notification */
function showToast(message, icon = 'bi-check-circle-fill') {
  document.querySelector('.toast-notify')?.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notify';
  toast.innerHTML = `<i class="bi ${icon}"></i> ${message}`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease';
    toast.style.opacity    = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}


/* ================================================================
   7. WORD & CHARACTER COUNT
================================================================ */
function updateLiveWordCount() {
  let wordCount = 0;
  transcriptEl.querySelectorAll('.final-line').forEach(p => {
    const words = p.textContent.trim().split(/\s+/);
    wordCount += words.filter(w => w.length > 0).length;
  });
  liveWordCount.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''}`;
}

function updateEditorCount() {
  const text  = transcriptEditor.value;
  const chars = text.length;
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  charCountEl.textContent = `${chars} character${chars !== 1 ? 's' : ''}`;
  wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
}

transcriptEditor.addEventListener('input', updateEditorCount);


/* ================================================================
   8. COPY TO CLIPBOARD
================================================================ */
copyBtn.addEventListener('click', () => {
  const text = transcriptEditor.value.trim();
  if (!text) { showToast('Nothing to copy yet.', 'bi-exclamation-circle'); return; }

  navigator.clipboard.writeText(text)
    .then(() => showToast('Transcript copied to clipboard!'))
    .catch(() => {
      transcriptEditor.select();
      document.execCommand('copy');
      showToast('Transcript copied!');
    });
});


/* ================================================================
   9. DOWNLOAD TRANSCRIPT
================================================================ */
downloadBtn.addEventListener('click', () => {
  const text = transcriptEditor.value.trim();
  if (!text) { showToast('Nothing to download yet.', 'bi-exclamation-circle'); return; }

  const now      = new Date();
  const stamp    = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const langName = langSelect.value
    ? langSelect.options[langSelect.selectedIndex].text.replace(/\s+/g, '-')
    : 'transcript';
  const filename = `voicescript-${langName}-${stamp}.txt`;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Downloaded as ${filename}`);
});


/* ================================================================
   10. CLEAR TRANSCRIPTS
================================================================ */
function clearTranscripts() {
  transcriptEl.innerHTML = `
    <div class="placeholder-wrap">
      <i class="bi bi-mic placeholder-icon"></i>
      <p>Select a language and press <strong>Start Recording</strong> to begin.</p>
      <p class="placeholder-hint">Your live transcription will appear here word by word.</p>
    </div>
  `;
  transcriptEditor.value = '';
  liveWordCount.textContent = '0 words';
  updateEditorCount();
  setStatus('Cleared — ready for a new session.');
  showToast('Transcript cleared.', 'bi-trash3');
}


/* ================================================================
   11. EVENT LISTENERS
================================================================ */
startBtn.addEventListener('click', startRecognition);
stopBtn.addEventListener('click', stopRecognition);
clearBtn.addEventListener('click', clearTranscripts);

langSelect.addEventListener('change', () => {
  if (langSelect.value) {
    setStatus(`Language set to ${langSelect.options[langSelect.selectedIndex].text}. Press Start Recording when ready.`);
  }
});
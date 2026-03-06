import DiceBox from '/dice-box/dice-box.es.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(console.error);
}

let diceBox = null;
let questions = [];
let currentQuestion = null;
let currentAnswers = []; // array of { answer, author, age, audio, photos } for current question
let isRolling = false;
let allAnswersData = null;
let activeAuthorFilter = '';

// ── Media state ─────────────────────────────────────────────────────────────
let mediaRecorder = null;
let recordingChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let pendingAudioPath = null;
let pendingPhotoPaths = [];
let currentPlayingAudio = null;
let autoSpeak = true;

// Single reusable Audio element for TTS — avoids creating a new object per request
const ttsAudio = new Audio();

// ── Questions / members loading ─────────────────────────────────────────────

async function loadQuestions() {
  const res = await fetch('questions.json');
  const data = await res.json();
  questions = data.questions;
}

async function loadMembers() {
  try {
    const res = await fetch('/api/members');
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const members = await res.json(); // [{name, dob}]
    const select = document.getElementById('authorSelect');
    select.innerHTML = '<option value="">Select name…</option>';
    members.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      select.appendChild(opt);
    });
    const addNew = document.createElement('option');
    addNew.value = '__new__';
    addNew.textContent = '+ Add new name';
    select.appendChild(addNew);
  } catch {}
}

// ── Dice ────────────────────────────────────────────────────────────────────

async function initDice() {
  diceBox = new DiceBox('#dice-box', {
    assetPath: '/dice-box/',
    theme: 'rust',
    scale: 7,
    spinForce: 3,
    throwForce: 1,
    gravity: 1,
    lightIntensity: 2,
  });

  await diceBox.init();

  diceBox.onRollComplete = () => {
    isRolling = false;
    showQuestion(pickQuestion());
  };
}

// ── TTS ──────────────────────────────────────────────────────────────────────

function stopTts() {
  ttsAudio.pause();
  ttsAudio.onended = null;
  ttsAudio.onerror = null;
  ttsAudio.src = '';
  document.querySelectorAll('.speaking').forEach(el => el.classList.remove('speaking'));
}

async function speakText(text, btn) {
  if (btn.classList.contains('speaking')) { stopTts(); return; }
  stopTts();
  btn.classList.add('speaking');
  try {
    const url = '/api/speak?text=' + encodeURIComponent(text);
    ttsAudio.onended = () => btn.classList.remove('speaking');
    ttsAudio.onerror = () => btn.classList.remove('speaking');
    ttsAudio.src = url;
    ttsAudio.play();
  } catch {
    btn.classList.remove('speaking');
  }
}

function toggleAutoSpeak() {
  const btn = document.getElementById('speakBtn');
  autoSpeak = !autoSpeak;
  stopTts();
  btn.classList.toggle('speak-btn--muted', !autoSpeak);
  btn.title = autoSpeak ? 'Auto-reading on — tap to turn off' : 'Auto-reading off — tap to turn on';
  if (autoSpeak && currentQuestion) {
    speakText(currentQuestion.question, btn);
  }
}

// ── Overlay ─────────────────────────────────────────────────────────────────

function showOverlay() {
  document.getElementById('overlayBackdrop').hidden = false;
  document.getElementById('questionSection').hidden = false;
}

function hideOverlay() {
  stopTts();
  document.getElementById('overlayBackdrop').hidden = true;
  document.getElementById('questionSection').hidden = true;
}

function pickQuestion() {
  return questions[Math.floor(Math.random() * questions.length)];
}

// ── Existing answers badges ──────────────────────────────────────────────────

function renderExistingAnswers(answers) {
  const card = document.getElementById('existingAnswersCard');
  const list = document.getElementById('existingAnswersList');
  if (!answers || answers.length === 0) {
    card.hidden = true;
    return;
  }
  // Deduplicate badges by author name
  const seen = new Set();
  list.innerHTML = answers
    .filter(a => { const k = a.author || 'Anonymous'; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(a => `<span class="answered-badge">${escapeHtml(a.author || 'Anonymous')} ✓</span>`)
    .join('');
  card.hidden = false;
}

// ── Show question ────────────────────────────────────────────────────────────

async function showQuestion(question) {
  currentQuestion = question;
  currentAnswers = [];
  document.getElementById('questionCategory').textContent = question.category;
  document.getElementById('questionText').textContent = question.question;

  // Reset form
  document.getElementById('answerInput').value = '';
  setAnswerEnabled(false);
  document.getElementById('saveStatus').textContent = '';
  document.getElementById('authorSelect').value = '';
  document.getElementById('authorInput').value = '';
  document.getElementById('authorInput').hidden = true;
  document.getElementById('authorDobInput').value = '';
  document.getElementById('authorDobInput').hidden = true;
  document.querySelector('.author-dob-label').hidden = true;
  document.getElementById('existingAnswersCard').hidden = true;
  hideSaveConflict();

  // Reset media state
  pendingAudioPath = null;
  pendingPhotoPaths = [];
  renderMediaPreview();
  stopRecording();

  // Load all existing answers for this question
  try {
    const res = await fetch('/api/answers/' + question.id);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    currentAnswers = data.answers || [];
    renderExistingAnswers(currentAnswers);
  } catch {}

  document.getElementById('tapHint').textContent = '';
  showOverlay();

  if (autoSpeak) {
    setTimeout(() => speakText(currentQuestion.question, document.getElementById('speakBtn')), 350);
  }
}

// ── Answer / author helpers ──────────────────────────────────────────────────

function setAnswerEnabled(enabled) {
  document.getElementById('answerInput').disabled = !enabled;
  document.getElementById('answerInputShield').classList.toggle('active', !enabled);
  document.getElementById('recordBtn').classList.toggle('locked', !enabled);
  document.getElementById('photoBtn').classList.toggle('locked', !enabled);
}

function showSaveConflict() {
  document.getElementById('saveBtn').hidden = true;
  document.getElementById('saveConflict').hidden = false;
}

function hideSaveConflict() {
  document.getElementById('saveBtn').hidden = false;
  document.getElementById('saveConflict').hidden = true;
}

async function saveAnswer(forceNew = false) {
  if (!currentQuestion) return;
  const answer = document.getElementById('answerInput').value.trim();
  const select = document.getElementById('authorSelect');
  const authorInput = document.getElementById('authorInput');

  if (!answer) {
    setStatus('Write something before saving!', true);
    return;
  }

  let author = '';
  if (select.value === '__new__') {
    author = authorInput.value.trim();
    if (author) {
      const dob = document.getElementById('authorDobInput').value || null;
      await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: author, dob }),
      });
      await loadMembers();
      select.value = author;
      authorInput.hidden = true;
      authorInput.value = '';
      document.getElementById('authorDobInput').hidden = true;
      document.getElementById('authorDobInput').value = '';
      document.querySelector('.author-dob-label').hidden = true;
    }
  } else {
    author = select.value;
  }

  const authorKey = author.trim();

  // If this author already has an answer and we haven't confirmed, show conflict prompt
  if (!forceNew && currentAnswers.some(a => a.author === authorKey)) {
    showSaveConflict();
    return;
  }
  hideSaveConflict();

  try {
    const res = await fetch('/api/answers/' + currentQuestion.id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer,
        author,
        audio: pendingAudioPath || undefined,
        photos: pendingPhotoPaths.length ? pendingPhotoPaths : undefined,
        forceNew: forceNew || undefined,
      }),
    });
    if (res.status === 401) { window.location.href = '/login.html'; return; }

    const entry = {
      answer, author: authorKey,
      ...(pendingAudioPath && { audio: pendingAudioPath }),
      ...(pendingPhotoPaths.length && { photos: [...pendingPhotoPaths] }),
    };
    if (forceNew) {
      currentAnswers.push(entry);
    } else {
      // Replace all existing entries for this author
      const filtered = currentAnswers.filter(a => a.author !== authorKey);
      currentAnswers.length = 0;
      currentAnswers.push(...filtered, entry);
    }
    renderExistingAnswers(currentAnswers);

    setStatus('Answer saved!');
    setTimeout(() => setStatus(''), 3000);
  } catch {
    setStatus('Save failed. Try again.', true);
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('saveStatus');
  el.textContent = msg;
  el.classList.toggle('save-status--error', isError);
}

// ── Answers panel ────────────────────────────────────────────────────────────

function renderAnswersPanel() {
  const filterEl = document.getElementById('answersFilter');
  const list = document.getElementById('answersList');
  if (!allAnswersData) return;

  // Collect unique authors
  const authors = new Set();
  for (const entries of Object.values(allAnswersData)) {
    for (const a of entries) { if (a.author) authors.add(a.author); }
  }

  // Filter chips
  filterEl.innerHTML = ['', ...authors].map(author => {
    const label = author || 'All';
    const active = activeAuthorFilter === author;
    return `<button class="filter-chip${active ? ' filter-chip--active' : ''}" data-author="${escapeHtml(author)}">${escapeHtml(label)}</button>`;
  }).join('');

  filterEl.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeAuthorFilter = btn.dataset.author;
      renderAnswersPanel();
    });
  });

  const entries = questions.filter(q => {
    const qAnswers = allAnswersData[q.id];
    if (!qAnswers || qAnswers.length === 0) return false;
    if (!activeAuthorFilter) return true;
    return qAnswers.some(a => a.author === activeAuthorFilter);
  });

  if (entries.length === 0) {
    list.innerHTML = '<p class="answers-empty">No answers saved yet.</p>';
    return;
  }

  // Group by category
  const byCategory = {};
  for (const q of entries) {
    if (!byCategory[q.category]) byCategory[q.category] = [];
    byCategory[q.category].push(q);
  }

  list.innerHTML = Object.entries(byCategory).map(([category, qs]) => `
    <div class="category-group">
      <p class="question-category">${escapeHtml(category)}</p>
      ${qs.map(q => {
        const qAnswers = allAnswersData[q.id];
        const shown = activeAuthorFilter
          ? qAnswers.filter(a => a.author === activeAuthorFilter)
          : qAnswers;
        return `
          <div class="answer-entry">
            <div class="answer-entry-header">
              <p class="answer-entry-question">${escapeHtml(q.question)}</p>
              <button class="answer-speak-btn" data-qid="${q.id}" title="Read aloud" type="button">🔊</button>
              <button class="answer-edit-btn" data-qid="${q.id}" title="Add or edit a response" type="button">✏</button>
            </div>
            ${shown.map(a => `
              <div class="answer-sub-entry">
                <p class="answer-entry-answer">${escapeHtml(a.answer)}</p>
                ${a.author ? `<p class="answer-author">— ${escapeHtml(a.author)}${a.age != null ? `, ${a.age}` : ''}</p>` : ''}
                ${renderAnswerMedia(a)}
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `).join('');

  // Wire up speak buttons
  list.querySelectorAll('.answer-speak-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = questions.find(q => String(q.id) === btn.dataset.qid);
      if (q) speakText(q.question, btn);
    });
  });

  // Wire up edit buttons
  list.querySelectorAll('.answer-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = questions.find(q => String(q.id) === btn.dataset.qid);
      if (q) { closeAnswers(); showQuestion(q); }
    });
  });

  // Wire up media interactions after rendering
  list.querySelectorAll('.answer-play-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleAnswerAudio(btn));
  });
  list.querySelectorAll('.answer-photo-thumb').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
  });
}

function renderAnswerMedia(a) {
  if (!a.audio && (!a.photos || !a.photos.length)) return '';
  let html = '<div class="answer-media">';
  if (a.audio) {
    html += `<button class="answer-play-btn" data-src="/${escapeHtml(a.audio)}">▶ Play</button>`;
  }
  if (a.photos && a.photos.length) {
    a.photos.forEach(p => {
      html += `<img class="answer-photo-thumb" src="/${escapeHtml(p)}" alt="photo" loading="lazy" />`;
    });
  }
  html += '</div>';
  return html;
}

function toggleAnswerAudio(btn) {
  const src = btn.dataset.src;
  if (currentPlayingAudio && !currentPlayingAudio.paused) {
    currentPlayingAudio.pause();
    if (currentPlayingAudio.getAttribute('data-src') === src) {
      currentPlayingAudio = null;
      btn.textContent = '▶ Play';
      return;
    }
  }
  document.querySelectorAll('.answer-play-btn').forEach(b => { b.textContent = '▶ Play'; });
  currentPlayingAudio = new Audio(src);
  currentPlayingAudio.setAttribute('data-src', src);
  currentPlayingAudio.play();
  btn.textContent = '■ Stop';
  currentPlayingAudio.onended = () => { btn.textContent = '▶ Play'; currentPlayingAudio = null; };
}

async function openAnswers() {
  const list = document.getElementById('answersList');
  list.innerHTML = '<p class="answers-empty">Loading…</p>';
  document.getElementById('answersFilter').innerHTML = '';
  document.getElementById('answersBackdrop').hidden = false;
  document.getElementById('answersPanel').hidden = false;
  activeAuthorFilter = '';

  try {
    const res = await fetch('/api/answers');
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    allAnswersData = await res.json();
    renderAnswersPanel();
  } catch {
    list.innerHTML = '<p class="answers-empty">Failed to load answers.</p>';
  }
}

function closeAnswers() {
  stopTts();
  document.getElementById('answersBackdrop').hidden = true;
  document.getElementById('answersPanel').hidden = true;
}

// ── Photo lightbox ───────────────────────────────────────────────────────────

function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('photoLightbox').hidden = false;
}

function closeLightbox() {
  document.getElementById('photoLightbox').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

// ── Chunked upload ───────────────────────────────────────────────────────────

async function uploadChunked(blob, mimeType) {
  const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB
  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
  const uploadId = crypto.randomUUID();

  for (let i = 0; i < totalChunks; i++) {
    const chunk = blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('chunkIndex', i);
    form.append('totalChunks', totalChunks);
    form.append('mimeType', mimeType);
    form.append('chunk', chunk, 'data');

    const res = await fetch('/api/upload/chunk', { method: 'POST', body: form });
    if (!res.ok) throw new Error('Upload failed');
    const result = await res.json();

    if (totalChunks > 1) {
      setStatus(`Uploading… ${Math.round(((i + 1) / totalChunks) * 100)}%`);
    }

    if (result.done) return result;
  }
}

// ── Audio recording ──────────────────────────────────────────────────────────

function getMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recordingChunks = [];
    recordingSeconds = 0;

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordingChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType });
      await processAudioUpload(blob);
    };

    mediaRecorder.start(250);
    updateRecordingUI(true);
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
      const s = String(recordingSeconds % 60).padStart(2, '0');
      document.getElementById('recordLabel').textContent = `${m}:${s}`;
    }, 1000);
  } catch {
    setStatus('Microphone access denied.', true);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  clearInterval(recordingTimer);
  recordingTimer = null;
  updateRecordingUI(false);
}

function updateRecordingUI(recording) {
  const btn = document.getElementById('recordBtn');
  const label = document.getElementById('recordLabel');
  btn.classList.toggle('recording', recording);
  if (!recording) label.textContent = 'Record';
}

async function processAudioUpload(blob) {
  setStatus('Uploading…');
  try {
    const result = await uploadChunked(blob, blob.type || 'audio/webm');
    if (result && result.done) {
      pendingAudioPath = result.path;
      if (result.transcription) {
        document.getElementById('answerInput').value = result.transcription;
        const select = document.getElementById('authorSelect');
        if (select.value && select.value !== '__new__') setAnswerEnabled(true);
        setStatus('Transcribed! Edit if needed, then save.');
      } else {
        setStatus('Audio saved. Add your written answer too.');
      }
      renderMediaPreview();
    }
  } catch {
    setStatus('Upload failed. Try again.', true);
  }
}

// ── Photo capture ────────────────────────────────────────────────────────────

async function compressImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(resolve, 'image/jpeg', 0.82);
    };
    img.src = url;
  });
}

async function handlePhotoSelected(file) {
  setStatus('Uploading photo…');
  try {
    const compressed = await compressImage(file);
    const result = await uploadChunked(compressed, 'image/jpeg');
    if (result && result.done) {
      pendingPhotoPaths.push(result.path);
      setStatus('Photo added!');
      setTimeout(() => setStatus(''), 2000);
      renderMediaPreview();
    }
  } catch {
    setStatus('Photo upload failed.', true);
  }
}

// ── Media preview (in answer card) ──────────────────────────────────────────

function renderMediaPreview() {
  const el = document.getElementById('mediaPreview');
  let html = '';

  if (pendingAudioPath) {
    html += `
      <div class="media-audio-preview">
        <audio controls src="/${escapeHtml(pendingAudioPath)}" preload="none"></audio>
        <button class="media-remove-btn" id="removeAudioBtn" type="button" title="Remove">✕</button>
      </div>`;
  }

  if (pendingPhotoPaths.length) {
    html += '<div class="media-photos-preview">';
    pendingPhotoPaths.forEach((p, i) => {
      html += `
        <div class="photo-thumb-wrap">
          <img class="photo-thumb" src="/${escapeHtml(p)}" alt="photo" />
          <button class="media-remove-btn" data-idx="${i}" type="button" title="Remove">✕</button>
        </div>`;
    });
    html += '</div>';
  }

  el.innerHTML = html;
  el.hidden = !pendingAudioPath && !pendingPhotoPaths.length;

  if (pendingAudioPath) {
    el.querySelector('#removeAudioBtn').addEventListener('click', () => {
      pendingAudioPath = null;
      renderMediaPreview();
    });
  }
  el.querySelectorAll('.media-photos-preview .media-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingPhotoPaths.splice(parseInt(btn.dataset.idx), 1);
      renderMediaPreview();
    });
  });
  el.querySelectorAll('.photo-thumb').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.src));
  });
}

// ── Dice ─────────────────────────────────────────────────────────────────────

const RAINBOW = ['#ff0055', '#ff6600', '#ffcc00', '#00cc44', '#0088ff', '#aa00ff', '#ff00cc'];

function rainbowColor() {
  return RAINBOW[Math.floor(Math.random() * RAINBOW.length)];
}

function handleRoll() {
  if (isRolling) return;
  isRolling = true;
  hideOverlay();
  document.getElementById('tapHint').textContent = '';
  diceBox.roll([
    { qty: 1, sides: 10, theme: 'rust', themeColor: rainbowColor() },
    { qty: 1, sides: 10, theme: 'rust', themeColor: rainbowColor() },
  ]);
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Wire up all event listeners immediately — don't let async init failures block them
  document.getElementById('dice-box').addEventListener('click', handleRoll);
  document.getElementById('speakBtn').addEventListener('click', toggleAutoSpeak);
  document.getElementById('saveBtn').addEventListener('click', () => saveAnswer(false));
  document.getElementById('saveReplaceBtn').addEventListener('click', () => saveAnswer(false));
  document.getElementById('saveAddBtn').addEventListener('click', () => saveAnswer(true));
  document.getElementById('rollAgainBtn').addEventListener('click', handleRoll);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('answersBtn').addEventListener('click', openAnswers);
  document.getElementById('answersBackdrop').addEventListener('click', closeAnswers);
  document.getElementById('photoLightbox').addEventListener('click', closeLightbox);

  // Record button — tap to start, tap again to stop
  document.getElementById('recordBtn').addEventListener('click', () => {
    if (document.getElementById('recordBtn').classList.contains('locked')) {
      flashAuthorSelect();
      return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // Photo button
  document.getElementById('photoBtn').addEventListener('click', () => {
    if (document.getElementById('photoBtn').classList.contains('locked')) {
      flashAuthorSelect();
      return;
    }
    document.getElementById('photoInput').click();
  });
  document.getElementById('photoInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handlePhotoSelected(file);
    e.target.value = '';
  });

  // Author select
  document.getElementById('authorSelect').addEventListener('change', () => {
    const select = document.getElementById('authorSelect');
    const authorInput = document.getElementById('authorInput');
    const answerInput = document.getElementById('answerInput');
    const dobInput = document.getElementById('authorDobInput');
    const dobLabel = document.querySelector('.author-dob-label');
    const isNew = select.value === '__new__';
    authorInput.hidden = !isNew;
    dobInput.hidden = !isNew;
    dobLabel.hidden = !isNew;
    if (isNew) {
      authorInput.focus();
      answerInput.value = '';
      setAnswerEnabled(false);
    } else if (select.value) {
      hideSaveConflict();
      const existing = currentAnswers.findLast(a => a.author === select.value);
      answerInput.value = existing ? existing.answer : '';
      // Restore existing media so re-saving preserves it
      pendingAudioPath = existing?.audio || null;
      pendingPhotoPaths = existing?.photos ? [...existing.photos] : [];
      renderMediaPreview();
      setAnswerEnabled(true);
    } else {
      hideSaveConflict();
      answerInput.value = '';
      pendingAudioPath = null;
      pendingPhotoPaths = [];
      renderMediaPreview();
      setAnswerEnabled(false);
    }
  });

  document.getElementById('authorInput').addEventListener('input', () => {
    const hasName = document.getElementById('authorInput').value.trim().length > 0;
    setAnswerEnabled(hasName);
  });

  // Flash the author select — used by textarea shield, record, and photo buttons
  function flashAuthorSelect() {
    const el = document.getElementById('authorSelect');
    el.classList.remove('prompt-flash');
    void el.offsetWidth;
    el.classList.add('prompt-flash');
    el.addEventListener('animationend', () => el.classList.remove('prompt-flash'), { once: true });
  }
  document.getElementById('answerInputShield').addEventListener('click', flashAuthorSelect);
  document.getElementById('answerInputShield').addEventListener('touchstart', flashAuthorSelect, { passive: true });

  // Dismiss question section by tapping the padding
  document.getElementById('questionSection').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      hideOverlay();
      document.getElementById('tapHint').textContent = 'Tap to roll again';
    }
  });

  // Load data and dice — dice failure is isolated so other features still work
  try {
    await Promise.all([loadQuestions(), loadMembers()]);
  } catch (e) {
    console.error('Failed to load app data:', e);
    document.getElementById('tapHint').textContent = 'Failed to load. Refresh to try again.';
    return;
  }
  document.getElementById('tapHint').textContent = 'Loading dice…';
  try {
    await initDice();
    document.getElementById('tapHint').textContent = 'Tap to roll';
  } catch (e) {
    console.error('Dice init failed:', e);
    document.getElementById('tapHint').textContent = 'Tap to roll';
  }
});

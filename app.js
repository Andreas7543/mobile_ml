/* =====================================================
   Edge AI Inventory Scanner
   Gabungan Modul 1 sampai 4
   ===================================================== */

// ===== Konfigurasi Firebase =====
// Kosongkan apiKey dan projectId untuk memakai Demo Mode (database lokal).
const firebaseConfig = {
  apiKey: "AIzaSyA8iPvnR2E8QvA_a_f3YR1jyp0WRSbfCSo",
  authDomain: "expense-tracker-mahasisw-6a4d7.firebaseapp.com",
  projectId: "expense-tracker-mahasisw-6a4d7",
  storageBucket: "expense-tracker-mahasisw-6a4d7.firebasestorage.app",
  messagingSenderId: "1034179714382",
  appId: "1:1034179714382:web:219bd484ad1291b8fa521f",
};

const COLLECTION_NAME = "inventory_logs";
const DEVICE_ID = "BROWSER-" + Math.random().toString(36).slice(2, 6).toUpperCase();

// ===== Mock Database (Demo Mode) =====
// Meniru cara kerja Firestore memakai localStorage.
// Antar tab di browser yang sama tetap sinkron lewat event "storage".
class MockQuery {
  constructor(col, lim) {
    this.col = col;
    this.lim = lim;
  }

  orderBy() {
    return this; // Data sudah tersimpan terbaru di awal
  }

  limit(n) {
    return new MockQuery(this.col, n);
  }

  get() {
    return Promise.resolve(this.col.snapshot(this.lim));
  }

  onSnapshot(cb) {
    const handler = () => cb(this.col.snapshot(this.lim));
    this.col.listeners.push(handler);
    window.addEventListener("storage", (e) => {
      if (e.key === this.col.key) handler();
    });
    handler(); // Trigger pemuatan awal
    return () => {
      this.col.listeners = this.col.listeners.filter((fn) => fn !== handler);
    };
  }
}

class MockCollection {
  constructor(key) {
    this.key = key;
    this.listeners = [];
  }

  load() {
    return JSON.parse(localStorage.getItem(this.key) || "[]");
  }

  snapshot(lim) {
    const docs = this.load()
      .slice(0, lim || undefined)
      .map((d) => ({ id: d.id, data: () => d }));
    return { docs };
  }

  async add(payload) {
    const data = this.load();
    data.unshift({ ...payload, id: Date.now().toString() });
    if (data.length > 50) data.length = 50; // Batasi 50 dokumen
    localStorage.setItem(this.key, JSON.stringify(data));
    this.listeners.forEach((fn) => fn());
  }

  orderBy() {
    return new MockQuery(this);
  }
}

class MockFirestore {
  collection(name) {
    return new MockCollection("mock_" + name);
  }
}

// ===== Elemen =====
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const container = document.getElementById("camera-container");
const overlay = document.getElementById("overlay-msg");
const overlayText = document.getElementById("overlay-text");
const overlaySub = document.getElementById("overlay-sub");
const spinner = document.getElementById("spinner");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnAI = document.getElementById("btn-ai");
const btnExport = document.getElementById("btn-export");
const chkPersonOnly = document.getElementById("chk-person-only");
const personCountEl = document.getElementById("person-count");
const toastEl = document.getElementById("toast");
const dbStatusEl = document.getElementById("db-status");
const dataList = document.getElementById("data-list");
const logCountEl = document.getElementById("log-count");

// ===== Status =====
let db = null;
let collectionRef = null;
let isMockMode = true;
let model = null; // Menyimpan model COCO-SSD
let isCameraOn = false;
let isAIDetecting = false;

// ===== Kelas target =====
// Catatan: 'pen' tidak ada di daftar 80 kelas COCO, jadi tidak dipakai.
const TARGET_CLASSES_SEMUA = [
  "mouse",
  "keyboard",
  "cell phone",
  "book",
  "scissors",
  "laptop",
  "person",
];
const TARGET_CLASSES_PERSON = ["person"]; // Untuk tantangan
let TARGET_CLASSES = TARGET_CLASSES_SEMUA;
const MIN_SCORE = 0.6; // Confidence minimal 60%

// Throttling penyimpanan
let lastSaveTime = 0;
const SAVE_THROTTLE_MS = 3000; // Simpan maksimal setiap 3 detik

// ===== Fungsi bantu tampilan =====
function showOverlay(teks, sub = "", loading = false) {
  overlayText.textContent = teks;
  overlaySub.textContent = sub;
  spinner.style.display = loading ? "block" : "none";
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

let toastTimer = null;
function showToast(teks) {
  toastEl.textContent = teks;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function updatePersonCount(jumlah) {
  personCountEl.textContent = "Jumlah orang: " + jumlah;
}

function setDbStatus(teks, kelas) {
  dbStatusEl.textContent = teks;
  dbStatusEl.className = "status-badge " + kelas;
}

function showEmptyState(teks) {
  dataList.replaceChildren();
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = teks;
  dataList.appendChild(div);
}

// Ubah timestamp Firestore, ISO string, atau Date menjadi objek Date
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// ===== Database =====
function initDatabase() {
  const configValid = firebaseConfig.apiKey && firebaseConfig.projectId;

  if (configValid && typeof firebase !== "undefined") {
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      isMockMode = false;
      setDbStatus("FIREBASE ONLINE", "online");
    } catch (e) {
      console.error("Firebase init error:", e);
    }
  }

  // Jika Firebase gagal atau kosong, pakai Mock Database
  if (isMockMode) {
    db = new MockFirestore();
    setDbStatus("DEMO MODE", "demo");
  }

  collectionRef = db.collection(COLLECTION_NAME);
}

async function saveToDatabase(data) {
  try {
    // Format data menjadi string yang mudah dibaca
    const itemsString = data.map((d) => `${d.class} (${d.confidence}%)`).join(", ");

    const payload = {
      items: itemsString, // "laptop (95%), person (87%)"
      count: data.length, // Jumlah objek terdeteksi
      device_id: DEVICE_ID, // Identifier perangkat
      timestamp: isMockMode
        ? new Date().toISOString()
        : firebase.firestore.FieldValue.serverTimestamp(),
    };

    await collectionRef.add(payload);
    showToast(`Tersimpan: ${data.length} objek`);
    console.log("Data tersimpan:", payload);
  } catch (err) {
    console.error("Gagal menyimpan ke database:", err);
    showToast("Gagal menyimpan ke database");
  }
}

function listenToDatabase() {
  // Dengarkan perubahan pada koleksi, urutkan berdasarkan timestamp terbaru
  collectionRef
    .orderBy("timestamp", "desc")
    .limit(30) // Hanya ambil 30 dokumen terbaru
    .onSnapshot(
      (snapshot) => renderLog(snapshot),
      (err) => {
        console.error("Gagal membaca database:", err);
        setDbStatus("FIREBASE ERROR", "error");
        showEmptyState("Gagal membaca database. Cek aturan Firestore Anda.");
      }
    );
}

function renderLog(snapshot) {
  dataList.replaceChildren();

  snapshot.docs.forEach((doc) => {
    const data = doc.data({ serverTimestamps: "estimate" });
    const date = toDate(data.timestamp);
    const timeStr = date ? date.toLocaleTimeString("id-ID") : "Baru saja";

    const div = document.createElement("div");
    div.className = "log-item";

    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = `${timeStr} | ${data.device_id || "-"}`;

    const itemsEl = document.createElement("span");
    itemsEl.className = "items";
    itemsEl.textContent = data.items;

    div.appendChild(timeEl);
    div.appendChild(itemsEl);
    dataList.appendChild(div);
  });

  logCountEl.textContent = `${snapshot.docs.length} items`;

  if (snapshot.docs.length === 0) {
    showEmptyState("Belum ada objek terdeteksi");
  }
}

// ===== Bonus: Export Log ke CSV =====
function csvCell(nilai) {
  return '"' + String(nilai).replace(/"/g, '""') + '"';
}

async function exportLogCSV() {
  try {
    // Ambil sampai 1000 log terbaru
    const snapshot = await collectionRef.orderBy("timestamp", "desc").limit(1000).get();

    if (snapshot.docs.length === 0) {
      showToast("Belum ada log untuk diekspor");
      return;
    }

    const baris = [["Waktu", "Perangkat", "Jumlah", "Objek"]];
    snapshot.docs.forEach((doc) => {
      const d = doc.data({ serverTimestamps: "estimate" });
      const date = toDate(d.timestamp);
      baris.push([
        date ? date.toLocaleString("id-ID") : "",
        d.device_id || "",
        d.count !== undefined ? d.count : "",
        d.items || "",
      ]);
    });

    // BOM agar Excel membaca UTF-8 dengan benar
    const csv = "\uFEFF" + baris.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory_log_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast(`Export berhasil: ${snapshot.docs.length} baris`);
  } catch (err) {
    console.error("Gagal export CSV:", err);
    showToast("Gagal export CSV");
  }
}

// ===== Model AI =====
async function loadModel() {
  showOverlay(
    "Memuat model AI (COCO-SSD)...",
    "Mengunduh bobot model sekitar 5MB. Mohon tunggu.",
    true
  );

  try {
    // Varian ringan: lebih cepat, sedikit kurang akurat
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    // Varian lain yang lebih akurat tapi lebih berat:
    // model = await cocoSsd.load({ base: "mobilenet_v2" });

    showOverlay('Model siap. Klik "Start Camera".');
    showToast("Model AI siap digunakan!");
    console.log("Model berhasil dimuat:", model);
  } catch (err) {
    console.error("Gagal memuat model:", err);
    showOverlay(
      "Gagal memuat model AI",
      "Periksa koneksi internet Anda. Model perlu diunduh pertama kali."
    );
  }

  // Kamera tetap bisa dipakai walau model gagal dimuat
  btnStart.disabled = false;
}

// ===== Kamera =====
async function startCamera() {
  showOverlay("Memulai Sistem...", "", true);
  btnStart.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        console.log("Resolusi kamera:", video.videoWidth, "x", video.videoHeight);
        // Samakan ukuran canvas dan rasio container dengan video
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        container.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
        resolve();
      };
    });

    isCameraOn = true;
    hideOverlay();
    btnStop.disabled = false;
    btnAI.disabled = !model; // Start AI aktif hanya jika model sudah siap
    console.log("Kamera berhasil dinyalakan!");
  } catch (err) {
    console.error("Gagal akses kamera:", err);
    showOverlay("Gagal akses kamera.", "Cek izin kamera dan pastikan memakai http://");
    btnStart.disabled = false;
    alert("Akses kamera ditolak. Pastikan izin kamera diizinkan di browser.");
  }
}

function stopCamera() {
  // Matikan AI lebih dulu
  stopAI();

  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }

  isCameraOn = false;
  showOverlay('Kamera dimatikan. Klik "Start Camera" untuk menyalakan lagi.');
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnAI.disabled = true;
  console.log("Kamera dimatikan.");
}

// ===== Loop deteksi =====
async function detectLoop() {
  // Hentikan loop jika AI dimatikan atau kamera mati
  if (!isAIDetecting || !isCameraOn) return;

  // Tunggu sampai frame video siap
  if (video.readyState >= 2) {
    try {
      const predictions = await model.detect(video);
      const detectedTargets = drawPredictions(predictions);

      // THROTTLING: hanya simpan jika sudah lewat 3 detik
      if (detectedTargets.length > 0 && Date.now() - lastSaveTime > SAVE_THROTTLE_MS) {
        lastSaveTime = Date.now(); // Update waktu sebelum menyimpan agar tidak dobel
        saveToDatabase(detectedTargets);
      }
    } catch (err) {
      console.error("Gagal mendeteksi:", err);
    }
  }

  // Panggil lagi di frame berikutnya
  requestAnimationFrame(detectLoop);
}

// Gambar bounding box dan kembalikan daftar objek target
function drawPredictions(predictions) {
  // Bersihkan canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Ukuran garis dan font mengikuti resolusi canvas
  const fontSize = Math.max(14, Math.round(canvas.width / 45));
  ctx.lineWidth = Math.max(3, Math.round(canvas.width / 300));
  ctx.font = "bold " + fontSize + "px sans-serif";

  const detectedTargets = [];
  let jumlahOrang = 0;

  predictions.forEach((pred) => {
    const [x, y, w, h] = pred.bbox;
    const isTarget = TARGET_CLASSES.includes(pred.class);
    const confidence = pred.score;

    if (pred.class === "person" && confidence > MIN_SCORE) {
      jumlahOrang++;
    }

    if (isTarget && confidence > MIN_SCORE) {
      // Kotak hijau dan label untuk objek target
      ctx.strokeStyle = "#10b981";
      ctx.strokeRect(x, y, w, h);

      const label = pred.class + " " + (confidence * 100).toFixed(0) + "%";
      const labelH = fontSize + 10;
      const labelY = y - labelH < 0 ? y : y - labelH; // Jaga agar tidak keluar canvas
      ctx.fillStyle = "#10b981";
      ctx.fillRect(x, labelY, ctx.measureText(label).width + 10, labelH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 5, labelY + fontSize);

      detectedTargets.push({
        class: pred.class,
        confidence: parseFloat((confidence * 100).toFixed(2)),
      });
    } else if (!isTarget) {
      // Kotak abu-abu untuk objek non-target
      ctx.strokeStyle = "#6b7280";
      ctx.strokeRect(x, y, w, h);
    }
  });

  updatePersonCount(jumlahOrang);
  return detectedTargets;
}

// ===== Tombol Start AI dan Stop AI =====
function startAI() {
  if (!model || !isCameraOn) return;
  isAIDetecting = true;
  btnAI.textContent = "Stop AI";
  btnAI.className = "btn btn-danger";
  detectLoop();
}

function stopAI() {
  isAIDetecting = false;
  btnAI.textContent = "Start AI";
  btnAI.className = "btn btn-success";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updatePersonCount(0);
}

// ===== Event tombol =====
btnStart.addEventListener("click", startCamera);
btnStop.addEventListener("click", stopCamera);
btnExport.addEventListener("click", exportLogCSV);

btnAI.addEventListener("click", () => {
  if (!isAIDetecting) {
    startAI();
  } else {
    stopAI();
  }
});

// Tantangan: hanya person
chkPersonOnly.addEventListener("change", () => {
  TARGET_CLASSES = chkPersonOnly.checked ? TARGET_CLASSES_PERSON : TARGET_CLASSES_SEMUA;
});

// ===== Urutan inisialisasi aplikasi =====
function initApp() {
  console.log("Memulai inisialisasi aplikasi...");

  // 1. Siapkan database (Firebase atau Mock)
  initDatabase();

  // 2. Mulai mendengarkan database
  listenToDatabase();

  // 3. Muat model AI
  loadModel();

  console.log("Inisialisasi selesai!");
}

// Jalankan saat DOM siap
document.addEventListener("DOMContentLoaded", initApp);
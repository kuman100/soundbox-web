// page.js
"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  ref,
  onChildAdded,
  onValue,
  query,
  orderByChild,
  startAt,
  endAt,
  get,
  remove,
  set,
} from "firebase/database";
import { db } from "../firebase";

// ==========================================
// REGEX CLEANER: Bersihkan teks untuk TTS
// ==========================================
function normalizeAmount(raw) {
  let cleaned = raw.replace(/[.,]\d{2}$/, "");
  cleaned = cleaned.replace(/[.,]/g, "");
  const number = parseInt(cleaned, 10);
  if (isNaN(number)) return raw;
  return number.toLocaleString("id-ID");
}

function parseAmountNumber(raw) {
  let cleaned = raw.replace(/[.,]\d{2}$/, "");
  cleaned = cleaned.replace(/[.,]/g, "");
  return parseInt(cleaned, 10) || 0;
}

function buildSpeechText(appSource, rawContent) {
  const text = rawContent || "";
  const amountMatch = text.match(/(?:IDR|Rp\.?)\s*([\d.,]+)/i);
  const amount = amountMatch ? `Rp ${normalizeAmount(amountMatch[1])}` : null;
  const accountMatch = text.match(/(?:No\.?\s*Rek\.?|rekening)\s*(\d{6,16})/i);
  const accountLast4 = accountMatch ? accountMatch[1].slice(-4) : null;
  const balanceMatch = text.match(
    /[Ss]aldo\s+akhir\s*[:\-]?\s*(?:IDR|Rp\.?)?\s*([\d.,]+)/i,
  );
  const balance = balanceMatch
    ? `Rp ${normalizeAmount(balanceMatch[1])}`
    : null;

  if (amount) {
    let speech =
      appSource && appSource !== "Truecaller (SMS Bank)"
        ? `Pembayaran masuk dari ${appSource}, ${amount}`
        : `Dana masuk ${amount}`;
    if (accountLast4)
      speech += `, rekening berakhir ${accountLast4.split("").join(" ")}`;
    if (balance) speech += `. Saldo akhir ${balance}`;
    return speech;
  }
  return `Ada pembayaran masuk dari ${appSource || "Aplikasi"}`;
}

// Ambil nilai nominal mentah (angka) dari content untuk statistik
function extractAmountValue(content) {
  if (!content) return 0;
  const match = content.match(/(?:IDR|Rp\.?)\s*([\d.,]+)/i);
  if (!match) return 0;
  return parseAmountNumber(match[1]);
}

function formatRupiah(number) {
  return `Rp ${number.toLocaleString("id-ID")}`;
}

// ==========================================
// HOOK: Text-to-Speech dengan voice loading
// ==========================================
function useTTS() {
  const voicesRef = useRef([]);
  const readyRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      if (all.length > 0) {
        voicesRef.current = all;
        readyRef.current = true;
      }
    };

    loadVoices();
    // Chrome memuat voices async — harus tunggu event ini
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  const speak = useCallback((text) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = voicesRef.current;
    const indoVoices = voices.filter((v) => v.lang.includes("id"));
    const bestVoice =
      indoVoices.find((v) => v.name.includes("Google")) || indoVoices[0];
    if (bestVoice) utterance.voice = bestVoice;
    utterance.lang = "id-ID";
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }, []);

  return speak;
}

// ==========================================
// HOOK: Notifikasi Browser
// ==========================================
function useBrowserNotification() {
  const permissionRef = useRef("default");

  useEffect(() => {
    if ("Notification" in window) {
      permissionRef.current = Notification.permission;
      if (Notification.permission === "default") {
        Notification.requestPermission().then((p) => {
          permissionRef.current = p;
        });
      }
    }
  }, []);

  const notify = useCallback((title, body) => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    )
      return; // Hanya tampil saat tab tidak aktif
    if (permissionRef.current !== "granted") return;
    new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: "soundbox-payment", // Mencegah notif bertumpuk
    });
  }, []);

  return notify;
}

// ==========================================
// KOMPONEN UTAMA
// ==========================================
export default function Home() {
  const [payments, setPayments] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [lastAnnouncement, setLastAnnouncement] = useState("Sistem Siap");
  const [activeFilters, setActiveFilters] = useState([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [filterError, setFilterError] = useState("");
  const [isConnected, setIsConnected] = useState(null); // null = cek, true/false
  // Derived state — tidak perlu useState/useEffect, cukup dihitung ulang saat payments berubah
  const todayStats = (() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    const todayPayments = payments.filter(
      (p) => p.timestamp && p.timestamp >= todayTs,
    );
    const total = todayPayments.reduce(
      (sum, p) => sum + extractAmountValue(p.content || p.raw_content || ""),
      0,
    );
    return { count: todayPayments.length, total };
  })();

  const processedKeys = useRef(new Set());
  const speakText = useTTS();
  const sendBrowserNotif = useBrowserNotification();

  // ── Monitor koneksi Firebase ─────────────────────────────────────────────
  useEffect(() => {
    const connectedRef = ref(db, ".info/connected");
    const unsub = onValue(connectedRef, (snap) => {
      setIsConnected(snap.val() === true);
    });
    return () => unsub();
  }, []);

  // ── Sinkronisasi filter dari Firebase ────────────────────────────────────
  useEffect(() => {
    const filtersRef = ref(db, "filters/negative_keywords");
    const unsub = onValue(filtersRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const filters = Array.isArray(data)
          ? data.filter(Boolean)
          : Object.values(data).filter(Boolean);
        setActiveFilters(filters);
      } else {
        setActiveFilters([]);
      }
    });
    return () => unsub();
  }, []);

  // ── CRUD Filter ───────────────────────────────────────────────────────────
  const saveFiltersToFirebase = useCallback(async (newFilters) => {
    await set(ref(db, "filters/negative_keywords"), newFilters);
  }, []);

  const handleAddKeyword = useCallback(async () => {
    const keyword = newKeyword.trim().toLowerCase();
    if (!keyword) return;
    if (activeFilters.includes(keyword)) {
      setFilterError("Kata kunci sudah ada.");
      return;
    }
    setFilterError("");
    await saveFiltersToFirebase([...activeFilters, keyword]);
    setNewKeyword("");
  }, [newKeyword, activeFilters, saveFiltersToFirebase]);

  const handleDeleteKeyword = useCallback(
    async (keyword) => {
      await saveFiltersToFirebase(activeFilters.filter((f) => f !== keyword));
    },
    [activeFilters, saveFiltersToFirebase],
  );

  // ── Hapus item riwayat dari Firebase & state ──────────────────────────────
  const handleDeletePayment = useCallback(async (index, firebaseKey) => {
    if (firebaseKey) {
      await remove(ref(db, `incoming_payments/${firebaseKey}`));
    }
    setPayments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Listener incoming_payments ────────────────────────────────────────────
  useEffect(() => {
    if (!isListening) return;

    const startTime = Date.now();
    const recentQuery = query(
      ref(db, "incoming_payments"),
      orderByChild("timestamp"),
      startAt(startTime),
    );

    const unsub = onChildAdded(recentQuery, (snapshot) => {
      const data = snapshot.val();
      const key = snapshot.key;
      if (processedKeys.current.has(key)) return;
      processedKeys.current.add(key);

      // Simpan key Firebase di dalam data untuk keperluan hapus
      setPayments((prev) => [{ ...data, _key: key }, ...prev]);

      const speechText = buildSpeechText(
        data.app_source,
        data.content || data.raw_content || "",
      );
      setLastAnnouncement(speechText);
      speakText(speechText);
      sendBrowserNotif(
        `💰 ${data.app_source || "Pembayaran Masuk"}`,
        data.amount ? `${data.amount} masuk` : speechText,
      );
    });
    return () => unsub();
  }, [isListening, speakText, sendBrowserNotif]);

  // ── Auto-hapus data lama (>1 jam) ────────────────────────────────────────
  useEffect(() => {
    const cleanupOldData = async () => {
      const oneHourAgo = Date.now() - 3600000;
      const snapshot = await get(
        query(
          ref(db, "incoming_payments"),
          orderByChild("timestamp"),
          endAt(oneHourAgo),
        ),
      );
      if (snapshot.exists()) {
        const promises = [];
        snapshot.forEach((child) => {
          promises.push(remove(ref(db, `incoming_payments/${child.key}`)));
        });
        await Promise.all(promises);
      }
    };
    cleanupOldData();
    const interval = setInterval(cleanupOldData, 900000);
    return () => clearInterval(interval);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleAddKeyword();
  };

  const handleTestTTS = () => {
    const testText =
      "Tes suara. Pembayaran masuk dari DANA, Rp 150.000. Saldo akhir Rp 500.000.";
    setLastAnnouncement(testText);
    speakText(testText);
  };

  // ── Warna indikator koneksi ───────────────────────────────────────────────
  const connDot =
    isConnected === null
      ? "bg-yellow-400"
      : isConnected
        ? "bg-emerald-400"
        : "bg-red-400";
  const connLabel =
    isConnected === null
      ? "Menghubungkan..."
      : isConnected
        ? "Terhubung"
        : "Terputus";

  return (
    <main className="min-h-screen bg-slate-900 text-white p-4 md:p-6 font-sans">
      <div className="max-w-4xl mx-auto space-y-6 mt-8">
        {/* ── Header & Status ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <h1 className="text-3xl font-bold text-emerald-400">
              Soundbox Kasir
            </h1>
          </div>

          {/* Status koneksi Firebase */}
          <div className="flex items-center justify-center gap-1.5 mb-5">
            <span className={`w-2 h-2 rounded-full ${connDot} animate-pulse`} />
            <span className="text-xs text-slate-400">{connLabel}</span>
          </div>

          <p className="text-amber-300 text-base mb-6 min-h-[1.5rem]">
            {lastAnnouncement}
          </p>

          <div className="flex gap-3 justify-center flex-wrap">
            <button
              onClick={() => setIsListening(true)}
              disabled={isListening}
              className={`px-8 py-3 rounded-xl font-bold text-sm transition-all ${
                isListening
                  ? "bg-emerald-900/50 text-emerald-400 cursor-default"
                  : "bg-emerald-500 hover:bg-emerald-600 text-white"
              }`}
            >
              {isListening ? "🟢 Sistem Aktif" : "▶ Aktifkan Pemantauan"}
            </button>

            {/* Tombol test TTS */}
            <button
              onClick={handleTestTTS}
              className="px-5 py-3 rounded-xl font-bold text-sm bg-white/10 hover:bg-white/20 transition-all text-slate-300"
              title="Tes apakah suara berfungsi"
            >
              🔊 Tes Suara
            </button>
          </div>
        </div>

        {/* ── Statistik Hari Ini ── */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5 text-center">
            <p className="text-slate-400 text-xs mb-1">Transaksi Hari Ini</p>
            <p className="text-3xl font-bold text-emerald-400">
              {todayStats.count}
            </p>
            <p className="text-slate-500 text-xs mt-1">pembayaran masuk</p>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-5 text-center">
            <p className="text-slate-400 text-xs mb-1">Total Nominal</p>
            <p className="text-xl font-bold text-white mt-1">
              {todayStats.total > 0 ? formatRupiah(todayStats.total) : "—"}
            </p>
            <p className="text-slate-500 text-xs mt-1">estimasi dari notif</p>
          </div>
        </div>

        {/* ── Manajemen Filter (CRUD) ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <h3 className="text-base font-semibold mb-1">
            Kata Kunci Terblokir
            <span className="ml-2 text-xs font-normal bg-white/10 text-slate-300 px-2 py-0.5 rounded-full">
              {activeFilters.length} aktif
            </span>
          </h3>
          <p className="text-slate-400 text-xs mb-4">
            Notifikasi yang mengandung kata-kata ini akan diabaikan otomatis.
          </p>

          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => {
                setNewKeyword(e.target.value);
                setFilterError("");
              }}
              onKeyDown={handleKeyDown}
              placeholder="Tambah kata kunci baru..."
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
            <button
              onClick={handleAddKeyword}
              disabled={!newKeyword.trim()}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-medium transition-colors"
            >
              + Tambah
            </button>
          </div>
          {filterError && (
            <p className="text-red-400 text-xs mb-3">{filterError}</p>
          )}

          {activeFilters.length === 0 ? (
            <p className="text-slate-500 text-xs italic">
              Belum ada kata kunci yang diblokir.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeFilters.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 bg-red-500/15 text-red-300 border border-red-500/20 px-3 py-1 rounded-full text-xs"
                >
                  {f}
                  <button
                    onClick={() => handleDeleteKeyword(f)}
                    className="hover:text-red-100 transition-colors leading-none"
                    title={`Hapus "${f}"`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Riwayat Pembayaran ── */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold">
              Riwayat Terakhir
              <span className="ml-2 text-xs font-normal text-slate-400">
                (hapus otomatis setelah 1 jam)
              </span>
            </h3>
            {payments.length > 0 && (
              <button
                onClick={() => setPayments([])}
                className="text-xs text-slate-500 hover:text-red-400 transition-colors"
              >
                Hapus semua tampilan
              </button>
            )}
          </div>

          {payments.length === 0 ? (
            <p className="text-slate-500 text-sm text-center py-6">
              Belum ada transaksi masuk.
            </p>
          ) : (
            <div className="space-y-2">
              {payments.map((p, i) => {
                const speechPreview = buildSpeechText(
                  p.app_source,
                  p.content || p.raw_content || "",
                );
                const time = p.timestamp
                  ? new Date(p.timestamp).toLocaleTimeString("id-ID", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "";

                return (
                  <div
                    key={p._key || i}
                    className="bg-white/5 border border-white/5 p-4 rounded-xl group"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-emerald-400 font-semibold text-sm">
                            {p.app_source}
                          </span>
                          {p.amount && (
                            <span className="text-white font-bold text-sm">
                              {p.amount}
                            </span>
                          )}
                          {time && (
                            <span className="text-slate-500 text-xs">
                              {time}
                            </span>
                          )}
                        </div>
                        <p className="text-slate-400 text-xs leading-relaxed">
                          {speechPreview}
                        </p>
                      </div>
                      {/* Tombol putar ulang & hapus */}
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => {
                            speakText(speechPreview);
                            setLastAnnouncement(speechPreview);
                          }}
                          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                          title="Putar ulang suara"
                        >
                          🔊
                        </button>
                        <button
                          onClick={() => handleDeletePayment(i, p._key)}
                          className="p-1.5 rounded-lg hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                          title="Hapus item ini"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

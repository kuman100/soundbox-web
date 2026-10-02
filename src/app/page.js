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

export default function Home() {
  const [payments, setPayments] = useState([]);
  const [activeFilters, setActiveFilters] = useState([]);
  const [newKeyword, setNewKeyword] = useState("");

  // 1. Otomatis jalan sejak awal
  const [isListening, setIsListening] = useState(true);
  // 2. Status izin suara browser
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [lastAnnouncement, setLastAnnouncement] = useState(
    "Menunggu Izin Suara (Klik Sembarang Tempat)",
  );

  const processedKeys = useRef(new Set());

  // 3. Efek untuk "Membuka Kunci" Suara dengan 1 Klik Sembarang
  useEffect(() => {
    const unlockAudio = () => {
      if (!audioUnlocked && "speechSynthesis" in window) {
        // Pancing browser dengan suara kosong agar izin audio terbuka
        const utterance = new SpeechSynthesisUtterance("");
        utterance.volume = 0;
        window.speechSynthesis.speak(utterance);

        setAudioUnlocked(true);
        setLastAnnouncement("Sistem & Suara Aktif 🟢");

        // Hapus pendengar klik agar tidak membebani performa setelah aktif
        document.removeEventListener("click", unlockAudio);
        document.removeEventListener("touchstart", unlockAudio);
      }
    };

    document.addEventListener("click", unlockAudio);
    document.addEventListener("touchstart", unlockAudio);

    return () => {
      document.removeEventListener("click", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
  }, [audioUnlocked]);

  // Fungsi Text-to-Speech
  const speakText = useCallback((text) => {
    if ("speechSynthesis" in window) {
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      let voices = synth.getVoices();
      let indoVoices = voices.filter((v) => v.lang.includes("id"));
      let bestVoice =
        indoVoices.find((v) => v.name.includes("Google")) || indoVoices[0];
      if (bestVoice) utterance.voice = bestVoice;
      utterance.lang = "id-ID";
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      synth.speak(utterance);
    }
  }, []);

  // Efek Memantau Filter
  useEffect(() => {
    const filtersRef = ref(db, "filters/negative_keywords");
    const unsubscribe = onValue(filtersRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const filters = Array.isArray(data) ? data : Object.values(data);
        setActiveFilters(filters);
      }
    });
    return () => unsubscribe();
  }, []);

  // Efek Mendengarkan Transaksi Baru
  useEffect(() => {
    if (!isListening) return;

    const startTime = Date.now();
    const paymentsRef = ref(db, "incoming_payments");
    const recentPaymentsQuery = query(
      paymentsRef,
      orderByChild("timestamp"),
      startAt(startTime),
    );

    const unsubscribe = onChildAdded(recentPaymentsQuery, (snapshot) => {
      const data = snapshot.val();
      const key = snapshot.key;

      if (!processedKeys.current.has(key)) {
        processedKeys.current.add(key);
        setPayments((prev) => [data, ...prev]);
        const textToSpeak = `Ada pembayaran masuk, dari ${data.app_source || "Aplikasi"}. ${data.content || ""}`;

        setLastAnnouncement(textToSpeak);
        // Suara hanya dibunyikan jika browser sudah diizinkan (diklik)
        if (audioUnlocked) {
          speakText(textToSpeak);
        }
      }
    });
    return () => unsubscribe();
  }, [isListening, audioUnlocked, speakText]);

  // Fitur Auto-Hapus Data Lama (1 Jam)
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
        snapshot.forEach((child) =>
          remove(ref(db, `incoming_payments/${child.key}`)),
        );
      }
    };
    cleanupOldData();
    const interval = setInterval(cleanupOldData, 900000);
    return () => clearInterval(interval);
  }, []);

  // Fungsi CRUD Filter
  const addKeyword = () => {
    if (!newKeyword.trim()) return;
    const newFilterList = [...activeFilters, newKeyword.trim().toLowerCase()];
    set(ref(db, "filters/negative_keywords"), newFilterList);
    setNewKeyword("");
  };

  const deleteKeyword = (indexToDelete) => {
    const newFilterList = activeFilters.filter((_, i) => i !== indexToDelete);
    set(ref(db, "filters/negative_keywords"), newFilterList);
  };

  return (
    <main className="min-h-screen bg-slate-900 text-white p-6 font-sans">
      <div className="max-w-4xl mx-auto space-y-8 mt-10">
        {/* Header & Status */}
        <div
          className={`border rounded-2xl p-8 shadow-2xl text-center transition-all duration-500 ${audioUnlocked ? "bg-emerald-900/20 border-emerald-500/50" : "bg-red-900/20 border-red-500/50 cursor-pointer"}`}
        >
          <h1 className="text-3xl font-bold text-emerald-400 mb-4">
            Soundbox Kasir
          </h1>
          <h2
            className={`text-xl font-medium mb-2 ${audioUnlocked ? "text-emerald-300" : "text-red-400 animate-pulse"}`}
          >
            {lastAnnouncement}
          </h2>
          {!audioUnlocked && (
            <p className="text-sm text-slate-400 mt-4">
              Browser mewajibkan 1x klik pada layar untuk mengizinkan notifikasi
              suara.
            </p>
          )}
        </div>

        {/* Panel Filter CRUD */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <h3 className="text-lg font-bold mb-4">
            Kelola Kata Kunci Terblokir ({activeFilters.length})
          </h3>
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addKeyword()}
              placeholder="Masukkan kata blokir baru..."
              className="bg-slate-800 border border-white/10 rounded-xl px-4 py-2 flex-grow focus:outline-none focus:border-emerald-500 text-white"
            />
            <button
              onClick={addKeyword}
              className="bg-emerald-500 hover:bg-emerald-600 px-6 py-2 rounded-xl font-bold transition-colors"
            >
              Tambah
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeFilters.map((f, i) => (
              <span
                key={i}
                className="bg-red-500/10 text-red-300 px-3 py-1 rounded-full text-sm border border-red-500/20 flex items-center gap-2 group"
              >
                {f}
                <button
                  onClick={() => deleteKeyword(i)}
                  className="text-red-400/50 group-hover:text-red-400 font-bold ml-1"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Riwayat */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <h3 className="text-xl font-bold mb-4">Riwayat Terakhir</h3>
          <div className="space-y-3">
            {payments.length === 0 ? (
              <p className="text-center text-slate-500 py-4 italic">
                Belum ada data masuk (Otomatis mendengarkan...)
              </p>
            ) : (
              payments.map((p, i) => (
                <div
                  key={i}
                  className="bg-slate-800/50 p-4 rounded-xl flex flex-col md:flex-row justify-between md:items-center border border-white/5 hover:bg-slate-800 transition-colors gap-2"
                >
                  <span className="text-emerald-400 font-bold text-lg">
                    {p.app_source}
                  </span>
                  <span className="text-slate-300 md:text-right flex-1">
                    {p.content}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

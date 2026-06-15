import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Soundbox Kasir | Orient Web",
  description:
    "Sistem pemantauan notifikasi pembayaran dan kasir pintar secara real-time.",
  keywords: "kasir pintar, soundbox, notifikasi pembayaran, manajemen otomatis",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        className="min-h-full flex flex-col"
        suppressHydrationWarning={true}
      >
        {children}
      </body>
    </html>
  );
}

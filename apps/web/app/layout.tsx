import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "الو نون",
  description: "نان تازه امضادار و محصولات نانی منتخب، با سفارش چندکاناله و تحویل قابل رهگیری."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}

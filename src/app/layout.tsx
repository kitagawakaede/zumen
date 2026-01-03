import "./globals.css";

export const metadata = {
  title: "JRzumen",
  description: "Blueprint text extraction with Azure Document Intelligence and Gemini."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-[#f5f1ea] font-sans text-[#1f1d1a] antialiased">
        {children}
      </body>
    </html>
  );
}

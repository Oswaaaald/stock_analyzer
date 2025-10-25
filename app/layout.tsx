import "./globals.css"; // ⬅️ IMPORTANT : en haut du fichier

export const metadata = {
  title: "Stock Analyzer",
  description: "Verdict d'une action en 2–3 clics, no-key, global.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100">
        {children}
      </body>
    </html>
  );
}

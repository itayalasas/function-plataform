import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata = { title: "Function Platform · MVP" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="flex min-h-screen w-full">
          <Sidebar />
          <main className="flex-1 min-w-0 px-8 py-7">
            <div className="max-w-[1500px] mx-auto">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}

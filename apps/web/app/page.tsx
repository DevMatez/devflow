import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">Devflow</span>
          <nav className="flex gap-4 text-sm text-zinc-600">
            <Link href="/login" className="hover:text-zinc-900">Sign in</Link>
            <Link href="/dashboard" className="hover:text-zinc-900">Dashboard</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Devflow</h1>
        <p className="mt-4 max-w-lg text-lg text-zinc-600">
          Plan → Start → Code → Review → Merge → Ship. One workflow surface from ticket to
          deployment.
        </p>
        <p className="mt-6 text-sm text-zinc-500">
          Wave 5 frontend scaffold — modules land as APIs from Waves 1–4 ship.
        </p>
      </main>
    </div>
  );
}

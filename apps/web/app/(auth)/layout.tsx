import Link from 'next/link';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <Link href="/" className="text-sm font-semibold">Devflow</Link>
      </header>
      {children}
    </div>
  );
}

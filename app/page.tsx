"use client";

import dynamic from "next/dynamic";

const Terminal = dynamic(() => import("@/components/Terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-[#0b1020] text-slate-400">
      Loading terminal…
    </div>
  ),
});

export default function Home() {
  return <Terminal />;
}

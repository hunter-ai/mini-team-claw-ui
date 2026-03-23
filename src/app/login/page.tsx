import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/chat");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.12),transparent_26%),radial-gradient(circle_at_bottom_right,rgba(249,115,22,0.18),transparent_30%)]" />
      <div className="relative w-full max-w-md rounded-[2.4rem] border border-white/10 bg-black/30 p-8 shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur">
        <p className="text-xs uppercase tracking-[0.35em] text-amber-300/70">MiniTeamClawUI</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white">Team gateway, isolated sessions.</h1>
        <p className="mt-4 text-sm leading-7 text-stone-300">
          Sign in with your assigned member account. Each account is pinned to one OpenClaw agent
          and only exposes that member&apos;s sessions.
        </p>
        <div className="mt-8">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}

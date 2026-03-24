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
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.78),transparent_26%),linear-gradient(180deg,rgba(248,250,252,0.86),rgba(243,244,246,0.24))]" />
      <div className="ui-card relative w-full max-w-md rounded-[2.4rem] p-8">
        <p className="text-xs uppercase tracking-[0.35em] text-[color:var(--text-tertiary)]">MiniTeamClawUI</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
          Team gateway, isolated sessions.
        </h1>
        <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
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

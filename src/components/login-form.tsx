"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    setLoading(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? "Login failed");
      return;
    }

    router.push("/chat");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <label className="text-sm font-medium text-stone-200" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-stone-100 outline-none ring-0 placeholder:text-stone-500 focus:border-amber-400"
          placeholder="team member"
          autoComplete="username"
          required
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium text-stone-200" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-stone-100 outline-none ring-0 placeholder:text-stone-500 focus:border-amber-400"
          placeholder="••••••••"
          autoComplete="current-password"
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-amber-100"
      >
        {loading ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}

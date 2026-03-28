export function AdminPageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="ui-card rounded-[2rem] px-5 py-5 sm:px-6">
      <p className="text-[11px] uppercase tracking-[0.32em] text-[color:var(--text-tertiary)]">{eyebrow}</p>
      <h1 className="mt-3 text-[1.9rem] font-semibold tracking-tight text-[color:var(--text-primary)] sm:text-[2.35rem]">
        {title}
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-[color:var(--text-secondary)]">{description}</p>
    </section>
  );
}

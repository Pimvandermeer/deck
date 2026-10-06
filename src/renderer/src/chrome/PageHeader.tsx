import type { ReactNode } from "react";

/** The one header every page shares: an optional lead (a back link), the
 *  title in deck's display face, a line of context, then the page's actions
 *  on the right. Same height everywhere so switching pages never jumps. */
export function PageHeader({ title, lead, sub, children }: { title: string; lead?: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-edge px-6">
      {lead}
      <h1 className="shrink-0 font-display text-[17px] font-bold text-ink">{title}</h1>
      {sub && <div className="flex min-w-0 items-center gap-3 truncate text-[13px] text-mut">{sub}</div>}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A quiet header action: text or an icon in a thin outline. */
export function HeaderButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-edge2 px-2.5 text-[12px] text-soft hover:border-edge3 hover:text-ink disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

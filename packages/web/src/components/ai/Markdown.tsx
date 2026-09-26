/**
 * Markdown — an AI answer rendered in the product's type and colours: short paragraphs, lists, headings, code,
 * and GitHub tables (inside answers only). SQL blocks can carry an action (open in a SQL tab).
 */
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SquareTerminal } from 'lucide-react';

export function Markdown({ children, onOpenSql }: { children: string; onOpenSql?: (sql: string) => void }) {
  const components = {
    code({ className, children: c, ...props }: { className?: string; children?: ReactNode; inline?: boolean }) {
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      const text = String(c ?? '').replace(/\n$/, '');
      if (props.inline || !text.includes('\n')) return <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-2xs text-accent-200">{text}</code>;
      return (
        <div className="group relative my-2">
          <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-2xs text-zinc-200">{text}</pre>
          {lang === 'sql' && onOpenSql && (
            <button className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 text-2xs text-zinc-300 hover:text-zinc-50" onClick={() => onOpenSql(text)}>
              <SquareTerminal className="h-3 w-3" /> Open in SQL
            </button>
          )}
        </div>
      );
    },
    p: ({ children: c }: { children?: ReactNode }) => <p className="my-1.5 leading-relaxed">{c}</p>,
    ul: ({ children: c }: { children?: ReactNode }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{c}</ul>,
    ol: ({ children: c }: { children?: ReactNode }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{c}</ol>,
    h1: ({ children: c }: { children?: ReactNode }) => <h3 className="mb-1 mt-3 text-body font-semibold text-zinc-50">{c}</h3>,
    h2: ({ children: c }: { children?: ReactNode }) => <h3 className="mb-1 mt-3 text-body font-semibold text-zinc-50">{c}</h3>,
    h3: ({ children: c }: { children?: ReactNode }) => <h4 className="mb-1 mt-2 text-body font-semibold text-zinc-100">{c}</h4>,
    strong: ({ children: c }: { children?: ReactNode }) => <strong className="font-semibold text-zinc-50">{c}</strong>,
    // ui-lint-ignore: markdown tables inside AI replies
    table: ({ children: c }: { children?: ReactNode }) => <table className="my-2 w-full border-collapse font-mono text-2xs">{c}</table>,
    th: ({ children: c }: { children?: ReactNode }) => <th className="border border-zinc-800 bg-zinc-900 px-2 py-1 text-left">{c}</th>,
    td: ({ children: c }: { children?: ReactNode }) => <td className="border border-zinc-800 px-2 py-1">{c}</td>,
    a: ({ children: c, href }: { children?: ReactNode; href?: string }) => <a href={href} className="text-accent-300 underline" {...(href?.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}>{c}</a>,
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>{children}</ReactMarkdown>;
}

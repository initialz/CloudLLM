import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/* ───────────────────────── 页头 ───────────────────────── */

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between">
      <div className="flex items-center gap-3">
        {/* 霓虹竖条:页头的视觉锚点,呼应顶部光带 */}
        <span className="h-6 w-1 rounded-full bg-gradient-to-b from-neon to-violet shadow-glow" />
        <h1 className="text-xl font-bold tracking-tight text-ink">{title}</h1>
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

/* ───────────────────────── 卡片 ───────────────────────── */

export function Card({
  title,
  className = '',
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-line bg-panel transition-shadow hover:shadow-glow ${className}`}
    >
      {title && (
        <header className="border-b border-line px-5 py-3">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-dim">{title}</h2>
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ───────────────────────── 按钮 ───────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
};

const BUTTON_VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  // 主按钮:neon 描边,hover 时点亮辉光
  primary:
    'border border-neon/60 bg-neon/10 text-neon hover:bg-neon/20 hover:shadow-glow hover:border-neon',
  ghost: 'border border-line bg-transparent text-ink hover:border-neon/50 hover:text-neon',
  danger:
    'border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/70',
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANT[variant]} ${className}`}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

/* ───────────────────────── 输入框 ───────────────────────── */

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export function Input({ label, error, className = '', id, ...rest }: InputProps) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block font-mono text-xs tracking-wider text-subtle">{label}</span>
      )}
      <input
        id={id}
        {...rest}
        className={`w-full rounded-md border bg-bg px-3 py-2 text-sm text-ink outline-none transition placeholder:text-dim focus:shadow-glow ${
          error ? 'border-rose-500/60 focus:border-rose-500' : 'border-line focus:border-neon'
        } ${className}`}
      />
      {error && <span className="mt-1 block text-xs text-rose-400">{error}</span>}
    </label>
  );
}

/* ───────────────────────── 下拉选择 ───────────────────────── */

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
};

export function Select({ label, className = '', children, ...rest }: SelectProps) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block font-mono text-xs tracking-wider text-subtle">{label}</span>
      )}
      <select
        {...rest}
        className={`w-full appearance-none rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition focus:border-neon focus:shadow-glow ${className}`}
      >
        {children}
      </select>
    </label>
  );
}

/* ───────────────────────── 开关 ───────────────────────── */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full border transition ${
          checked ? 'border-neon/60 bg-neon/20 shadow-glow' : 'border-line bg-bg'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            checked ? 'left-[18px] bg-neon' : 'left-0.5 bg-dim'
          }`}
        />
      </button>
      {label && <span className="text-sm text-ink">{label}</span>}
    </label>
  );
}

/* ───────────────────────── 表格 ───────────────────────── */

interface Column<T> {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  /** 列对齐:金额等数值列建议 right;默认 left */
  align?: 'left' | 'right';
  /** 列固定宽度(如操作列):CSS 长度值,如 '120px' */
  width?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = '暂无数据',
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-bg/60">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={`whitespace-nowrap px-4 py-2.5 font-mono text-xs font-normal uppercase tracking-wider text-dim ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-dim">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-line/50 transition last:border-0 hover:bg-bg/40"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={`whitespace-nowrap px-4 py-3 text-ink ${
                      c.align === 'right' ? 'text-right' : ''
                    }`}
                  >
                    {c.render ? c.render(row) : ((row as Record<string, ReactNode>)[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── 模态框 ───────────────────────── */

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // ESC 关闭 + 打开时锁定背景滚动
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div
        className="absolute inset-0 bg-bg/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-xl border border-line bg-panel shadow-glow`}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-dim transition hover:text-neon"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ───────────────────────── 状态徽标 ───────────────────────── */

// 状态 → 色彩映射:active/ok=neon、disabled/revoked=dim、cooldown=violet
const BADGE_MAP: Record<string, { cls: string; label: string }> = {
  active: { cls: 'border-neon/50 bg-neon/10 text-neon', label: '启用' },
  ok: { cls: 'border-neon/50 bg-neon/10 text-neon', label: '正常' },
  disabled: { cls: 'border-line bg-bg text-dim', label: '停用' },
  revoked: { cls: 'border-line bg-bg text-dim', label: '已吊销' },
  expired: { cls: 'border-line bg-bg text-dim', label: '已过期' },
  cooldown: { cls: 'border-violet/50 bg-violet/10 text-violet', label: '冷却中' },
};

export function Badge({ status }: { status: string }) {
  const m = BADGE_MAP[status] ?? { cls: 'border-line bg-bg text-dim', label: status };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] tracking-wider ${m.cls}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </span>
  );
}

/* ───────────────────────── 复制按钮 ───────────────────────── */

// 非安全上下文(如 http 内网)下 navigator.clipboard 不可用,用临时 textarea + execCommand 回退
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 移出可视区域,避免页面跳动/聚焦闪烁
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    let ok = false;
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = legacyCopy(text);
      }
    } else {
      ok = legacyCopy(text);
    }
    setState(ok ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-xs transition ${
        state === 'copied'
          ? 'border-neon/60 text-neon'
          : state === 'failed'
            ? 'border-rose-500/60 text-rose-300'
            : 'border-line text-dim hover:border-neon/50 hover:text-neon'
      }`}
    >
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </button>
  );
}

/* ───────────────────────── 错误条 ───────────────────────── */

export function ErrorBar({ message }: { message: string | null }) {
  if (!message) return null;
  // 错误语义色为例外:允许 rgba red(语义而非主题色)
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

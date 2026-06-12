// 计费金额内部单位:micro-CNY（百万分之一元）。1 元 = 1_000_000 micro。
const MICRO = 1_000_000;

/** micro-CNY → "¥1,234.56"(两位小数,千分位) */
export function fmtMicro(micro: number): string {
  const yuan = micro / MICRO;
  return `¥${yuan.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** micro-CNY → 保留到 6 位去尾零(价格明细用,如 "¥21.5") */
export function fmtMicroExact(micro: number): string {
  const yuan = micro / MICRO;
  // 最多 6 位小数、自动去除尾随零;千分位分组
  return `¥${yuan.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** epoch 秒 → "2026-06-12 14:30"(本地时区);null → "—" */
export function fmtTime(epoch: number | null): string {
  if (epoch == null) return '—';
  const d = new Date(epoch * 1000);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${date} ${time}`;
}

/**
 * epoch 秒 → 相对剩余("3 天后"/"2 小时后"/"5 分钟后"/"已过期");null → "—"
 * 冷却倒计时 / 过期展示用。
 */
export function fmtUntil(epoch: number | null): string {
  if (epoch == null) return '—';
  const diffSec = epoch - Date.now() / 1000;
  if (diffSec <= 0) return '已过期';
  const days = Math.floor(diffSec / 86400);
  if (days >= 1) return `${days} 天后`;
  const hours = Math.floor(diffSec / 3600);
  if (hours >= 1) return `${hours} 小时后`;
  const minutes = Math.max(1, Math.floor(diffSec / 60));
  return `${minutes} 分钟后`;
}

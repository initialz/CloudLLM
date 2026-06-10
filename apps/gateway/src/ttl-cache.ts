interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** 进程内 TTL 缓存,用于模型目录/渠道列表的热路径读 */
export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const value = await loader();
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}

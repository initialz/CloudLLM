import type { ChannelChoice, CooldownStore } from "./types.js";

/**
 * 返回有序候选渠道列表(供故障转移逐个尝试):
 * priority 升序分组;组内按 weight 加权随机排列;跳过 cooldown 中的渠道。
 */
export async function selectCandidates(
  channels: ChannelChoice[],
  cooldown: CooldownStore,
  rng: () => number = Math.random,
): Promise<ChannelChoice[]> {
  // 并发查冷却状态:热路径上避免 N 次串行 Redis 往返
  const cooling = await Promise.all(channels.map((c) => cooldown.isCooling(c.channelId)));
  const usable = channels.filter((_, i) => !cooling[i]);
  const groups = new Map<number, ChannelChoice[]>();
  for (const channel of usable) {
    const group = groups.get(channel.priority) ?? [];
    group.push(channel);
    groups.set(channel.priority, group);
  }
  const ordered: ChannelChoice[] = [];
  for (const priority of [...groups.keys()].sort((a, b) => a - b)) {
    ordered.push(...weightedShuffle(groups.get(priority)!, rng));
  }
  return ordered;
}

/** 加权不放回抽样:每轮按 weight 占比抽一个 */
function weightedShuffle(items: ChannelChoice[], rng: () => number): ChannelChoice[] {
  const pool = [...items];
  const result: ChannelChoice[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + Math.max(c.weight, 1), 0);
    let pick = rng() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      pick -= Math.max(pool[i]!.weight, 1);
      if (pick < 0) {
        idx = i;
        break;
      }
    }
    result.push(pool.splice(idx, 1)[0]!);
  }
  return result;
}

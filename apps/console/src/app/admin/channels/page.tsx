import { eq } from "drizzle-orm";
import { channels, providers } from "@cloudllm/db";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import ChannelsClient from "./channels-client";

export interface ChannelRow {
  id: string;
  name: string;
  providerDisplayName: string;
  baseUrl: string;
  status: string;
  cooldownUntil: Date | null;
  createdAt: Date;
}

export interface ProviderOption {
  id: string;
  type: string;
  displayName: string;
}

export default async function AdminChannelsPage() {
  await requireAdmin();

  const [channelRows, providerRows] = await Promise.all([
    db
      .select({
        id: channels.id,
        name: channels.name,
        baseUrl: channels.baseUrl,
        status: channels.status,
        cooldownUntil: channels.cooldownUntil,
        createdAt: channels.createdAt,
        providerId: channels.providerId,
      })
      .from(channels)
      .orderBy(channels.createdAt),
    db
      .select({ id: providers.id, type: providers.type, displayName: providers.displayName })
      .from(providers)
      .orderBy(providers.displayName),
  ]);

  // Build provider lookup map
  const providerMap = new Map(providerRows.map((p) => [p.id, p]));

  const rows: ChannelRow[] = channelRows.map((ch) => ({
    id: ch.id,
    name: ch.name,
    providerDisplayName: providerMap.get(ch.providerId)?.displayName ?? ch.providerId.slice(0, 8),
    baseUrl: ch.baseUrl,
    status: ch.status,
    cooldownUntil: ch.cooldownUntil,
    createdAt: ch.createdAt,
  }));

  const providerOptions: ProviderOption[] = providerRows;

  return <ChannelsClient channels={rows} providers={providerOptions} />;
}

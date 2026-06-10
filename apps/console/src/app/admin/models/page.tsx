import { eq } from "drizzle-orm";
import { channels, modelChannels, models, providers } from "@byok/db";
import { requireAdmin } from "../../../lib/auth";
import { db } from "../../../lib/db";
import ModelsClient from "./models-client";

export interface MappingRow {
  channelId: string;
  channelName: string;
  upstreamModelId: string;
  priority: number;
  weight: number;
}

export interface ModelRow {
  id: string;
  slug: string;
  displayName: string;
  providerType: string;
  priceInputCny: string;
  priceOutputCny: string;
  priceCacheReadCny: string;
  priceCacheWriteCny: string;
  contextLength: number | null;
  status: string;
  createdAt: Date;
  mappings: MappingRow[];
}

export interface ChannelOption {
  id: string;
  name: string;
  providerType: string;
}

export default async function AdminModelsPage() {
  await requireAdmin();

  const [modelRows, mappingRows, channelRows] = await Promise.all([
    db
      .select({
        id: models.id,
        slug: models.slug,
        displayName: models.displayName,
        providerType: models.providerType,
        priceInputCny: models.priceInputCny,
        priceOutputCny: models.priceOutputCny,
        priceCacheReadCny: models.priceCacheReadCny,
        priceCacheWriteCny: models.priceCacheWriteCny,
        contextLength: models.contextLength,
        status: models.status,
        createdAt: models.createdAt,
      })
      .from(models)
      .orderBy(models.createdAt),
    db
      .select({
        modelId: modelChannels.modelId,
        channelId: modelChannels.channelId,
        upstreamModelId: modelChannels.upstreamModelId,
        priority: modelChannels.priority,
        weight: modelChannels.weight,
        channelName: channels.name,
      })
      .from(modelChannels)
      .innerJoin(channels, eq(channels.id, modelChannels.channelId)),
    db
      .select({ id: channels.id, name: channels.name, providerType: providers.type })
      .from(channels)
      .innerJoin(providers, eq(providers.id, channels.providerId))
      .where(eq(channels.status, "active"))
      .orderBy(channels.name),
  ]);

  // Group mappings by model id
  const mappingsByModel = new Map<string, MappingRow[]>();
  for (const mc of mappingRows) {
    if (!mappingsByModel.has(mc.modelId)) {
      mappingsByModel.set(mc.modelId, []);
    }
    mappingsByModel.get(mc.modelId)!.push({
      channelId: mc.channelId,
      channelName: mc.channelName,
      upstreamModelId: mc.upstreamModelId,
      priority: mc.priority,
      weight: mc.weight,
    });
  }

  const rows: ModelRow[] = modelRows.map((m) => ({
    id: m.id,
    slug: m.slug,
    displayName: m.displayName,
    providerType: m.providerType,
    priceInputCny: m.priceInputCny,
    priceOutputCny: m.priceOutputCny,
    priceCacheReadCny: m.priceCacheReadCny,
    priceCacheWriteCny: m.priceCacheWriteCny,
    contextLength: m.contextLength,
    status: m.status,
    createdAt: m.createdAt,
    mappings: mappingsByModel.get(m.id) ?? [],
  }));

  const channelOptions: ChannelOption[] = channelRows;

  return <ModelsClient models={rows} channelOptions={channelOptions} />;
}

/**
 * marketApi.ts — M3 Sharing Market 前端 API 封装
 *
 * 封装 /api/sharing/* 调用，返回 camelCase 数据（与后端一致）。
 * 沿用 hanaFetch 鉴权范式（base url + appendConnectionAuth）。
 */

import { hanaFetch } from '../../react/hooks/use-hana-fetch';

export interface SharedAssetMeta {
  id: string;
  ownerId: string;
  ownerHandle: string;
  kind: 'tool' | 'workflow';
  title: string;
  summary: string;
  homepageUrl?: string;
  forkedFrom?: string;
  publishedAt: string;
  updatedAt: string;
  installCount: number;
}

export interface DiscoverItem extends SharedAssetMeta {
  extra?: Record<string, unknown>;
}

export interface PublishPayload {
  kind: 'tool' | 'workflow';
  sourceId: string;
  title: string;
  summary: string;
  homepageUrl?: string;
  forkedFrom?: string;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function listMine(): Promise<SharedAssetMeta[]> {
  const res = await hanaFetch('/api/sharing/mine');
  return (await json<{ assets: SharedAssetMeta[] }>(res)).assets;
}

export async function discover(): Promise<DiscoverItem[]> {
  const res = await hanaFetch('/api/sharing/discover');
  return (await json<{ assets: DiscoverItem[] }>(res)).assets;
}

export async function publish(payload: PublishPayload): Promise<{ id: string; status: 'published' }> {
  const res = await hanaFetch('/api/sharing/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json(res);
}

export async function unpublish(id: string): Promise<{ id: string; status: string }> {
  const res = await hanaFetch(`/api/sharing/unpublish/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return json(res);
}

export async function install(id: string): Promise<{ id: string; status: string; localId: string }> {
  const res = await hanaFetch('/api/sharing/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return json(res);
}

export const marketApi = { listMine, discover, publish, unpublish, install };

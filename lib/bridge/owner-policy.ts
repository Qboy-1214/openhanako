import { parseSessionKey } from "./session-key.ts";

export function getConfiguredBridgeOwner(agent, platform) {
  const owner = agent?.config?.bridge?.[platform]?.owner;
  return typeof owner === "string" && owner ? owner : null;
}

export function isBridgeOwner({ platform, chatType = "dm", userId, aliases, agent }) {
  if (!userId) return false;
  if (platform === "wechat") return chatType === "dm";

  // 新模型：bridge[platform].users[userId] = { defaultAgent, role }
  // role === "owner" 显式标记；role 缺省视为「绑定即本人」（与旧 owner 标量语义一致）。
  const users = agent?.config?.bridge?.[platform]?.users;
  if (users && typeof users === "object") {
    const binding = users[userId];
    if (binding) {
      const role = binding.role;
      if (role === "guest") return false;
      return role === "owner" || role === undefined || role === null || role === "user";
    }
  }

  const owner = getConfiguredBridgeOwner(agent, platform);
  if (!owner) return false;
  if (owner === userId) return true;
  if (platform !== "qq") return false;
  return normalizeStringList(aliases).includes(owner);
}

export function resolveBridgeOwnerUserId({ platform, agent, index }) {
  const configured = getConfiguredBridgeOwner(agent, platform);
  if (configured) return configured;

  // 新模型：users 中显式 role === "owner" 的用户。
  const users = agent?.config?.bridge?.[platform]?.users;
  if (users && typeof users === "object") {
    for (const [uid, binding] of Object.entries(users)) {
      if (binding && binding.role === "owner") return uid;
    }
  }

  if (platform !== "wechat") return null;
  return inferUniqueWechatOwnerFromIndex(index);
}

export function resolveBridgeOwnerDeliveryTarget({ platform, agent, index }) {
  const userId = resolveBridgeOwnerUserId({ platform, agent, index });
  if (!userId) return null;

  if (platform === "feishu") {
    return resolveFeishuDeliveryTarget(index, userId);
  }
  if (platform === "qq") {
    return resolveQQDeliveryTarget(index, userId) || { userId, chatId: userId, sessionKey: null };
  }

  return { userId, chatId: userId, sessionKey: null };
}

function resolveQQDeliveryTarget(index, ownerId) {
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const { platform, chatType, chatId: sessionChatId } = parseSessionKey(sessionKey);
    if (platform !== "qq" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    const principal = qqPrincipalFromEntry(entry, sessionChatId);
    if (!principal) continue;
    if (principal.principalId !== ownerId && !principal.aliases.includes(ownerId)) continue;

    return {
      userId: principal.principalId,
      chatId: entry.chatId || sessionChatId,
      sessionKey,
    };
  }
  return null;
}

function resolveFeishuDeliveryTarget(index, ownerId) {
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const { platform, chatType, chatId: sessionUserId } = parseSessionKey(sessionKey);
    if (platform !== "feishu" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    if (entry.userId !== ownerId && sessionUserId !== ownerId) continue;
    if (!entry.chatId) continue;
    return { userId: ownerId, chatId: entry.chatId, sessionKey };
  }
  return null;
}

function inferUniqueWechatOwnerFromIndex(index) {
  const ids = new Set();
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const { platform, chatType, chatId } = parseSessionKey(sessionKey);
    if (platform !== "wechat" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    const userId = entry.userId || chatId;
    if (userId) ids.add(userId);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function cleanString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

function normalizeStringList(values) {
  const result = [];
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    const s = cleanString(value);
    if (s && !result.includes(s)) result.push(s);
  }
  return result;
}

function qqPrincipalFromEntry(entry, sessionChatId) {
  const principal = entry.qqPrincipal && typeof entry.qqPrincipal === "object"
    ? entry.qqPrincipal
    : {};
  const principalId = cleanString(principal.principalId) || cleanString(entry.principalId) || cleanString(entry.userId);
  if (!principalId) return null;
  const aliases = normalizeStringList([
    principalId,
    ...(Array.isArray(principal.aliases) ? principal.aliases : []),
    entry.chatId,
    sessionChatId,
  ]);
  return { principalId, aliases };
}

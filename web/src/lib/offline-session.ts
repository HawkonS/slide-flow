import type { CurrentUser } from './types';

export interface OfflineIdentity {
  user: CurrentUser;
  sessionVersion: number;
  epoch: string;
  expiresAt: number;
}

interface SessionState { epoch: string; loggedOut: boolean; identity: OfflineIdentity | null }
export const OFFLINE_SESSION_KEY = 'slideflow-offline-session-v3';
export const OFFLINE_SESSION_EVENT = 'slideflow-offline-session-change';
const CHANGE_KEY = 'slideflow-pwa-change-v3';
const CHANNEL_NAME = 'slideflow-pwa-v3';
const tabId = newEpoch();
let memory: SessionState = { epoch: newEpoch(), loggedOut: false, identity: null };
let observedRaw: string | null | undefined;
let channel: BroadcastChannel | null = null;
let syncUsers = 0;
let storageReadable = true;

/**
 * Generate a browser-safe identifier without relying on an optional UUID API.
 * Older WebViews and some installed app shells expose getRandomValues but
 * omit that API, so playback must keep working in those environments too.
 */
export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  try {
    if (typeof cryptoApi?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Some embedded app shells expose Web Crypto but reject calls from their context.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function newEpoch(): string { return createClientId(); }

function snapshotUser(user: CurrentUser, sessionVersion: number): CurrentUser {
  // A local snapshot never carries management roles, grants, tags or secrets.
  return { id: user.id, username: user.username, name: user.name ?? null,
    role: 'user', session_version: sessionVersion, must_change_pwd: false };
}

function parseState(raw: string | null): SessionState | null {
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as SessionState;
    if (!state || typeof state.epoch !== 'string' || !state.epoch || state.epoch.length > 160
        || typeof state.loggedOut !== 'boolean') return null;
    if (state.loggedOut || !state.identity) return { epoch: state.epoch, loggedOut: state.loggedOut, identity: null };
    const identity = state.identity;
    if (identity.epoch !== state.epoch || !Number.isSafeInteger(identity.user?.id) || identity.user.id < 1
        || typeof identity.user.username !== 'string' || !Number.isSafeInteger(identity.sessionVersion)
        || identity.sessionVersion < 1 || !Number.isFinite(identity.expiresAt) || identity.expiresAt < 0) return null;
    return { epoch: state.epoch, loggedOut: false, identity: { ...identity,
      user: snapshotUser(identity.user, identity.sessionVersion) } };
  } catch { return null; }
}

function readState(): SessionState {
  try {
    const raw = window.localStorage.getItem(OFFLINE_SESSION_KEY);
    storageReadable = true;
    if (raw !== observedRaw) {
      observedRaw = raw;
      memory = parseState(raw) ?? { epoch: newEpoch(), loggedOut: false, identity: null };
    }
    return memory;
  } catch {
    storageReadable = false;
    // Storage failures disable offline access, not an independently verified login.
    return { ...memory, identity: null };
  }
}

function persist(state: SessionState, required = false): boolean {
  memory = state;
  try {
    const raw = JSON.stringify(state);
    window.localStorage.setItem(OFFLINE_SESSION_KEY, raw);
    observedRaw = raw;
    return true;
  } catch {
    memory = { ...state, identity: null };
    if (required) throw new Error('无法保存离线授权，请检查浏览器存储空间和权限');
    return false;
  }
}

function dispatch(type: string, detail: object): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(type, { detail }));
}

function broadcast(message: object): void {
  try { channel?.postMessage({ ...message, sender: tabId }); } catch { /* Storage events remain available. */ }
}

export interface PwaChange {
  ownerKey?: string;
  reason?: 'revoked' | 'deleted' | 'changed';
}

function safePwaChange(value: unknown): PwaChange & { showId?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const detail: PwaChange & { showId?: number } = {};
  if (typeof input.showId === 'number' && Number.isSafeInteger(input.showId) && input.showId > 0) detail.showId = input.showId;
  if (typeof input.ownerKey === 'string' && input.ownerKey.length > 0 && input.ownerKey.length <= 256) detail.ownerKey = input.ownerKey;
  if (input.reason === 'revoked' || input.reason === 'deleted' || input.reason === 'changed') detail.reason = input.reason;
  return detail;
}

export function notifyPwaChange(showId?: number, change?: PwaChange): void {
  const detail = { ...safePwaChange({ showId, ownerKey: change?.ownerKey, reason: change?.reason }), nonce: newEpoch(), sender: tabId };
  dispatch('slideflow-pwa-change', detail);
  try { window.localStorage.setItem(CHANGE_KEY, JSON.stringify(detail)); } catch { /* Best effort. */ }
  broadcast({ type: 'cache', ...detail });
}

function notifySessionChange(previousEpoch?: string): void {
  const state = readState();
  dispatch(OFFLINE_SESSION_EVENT, { remote: false, epoch: state.epoch });
  notifyPwaChange();
  broadcast({ type: 'session', epoch: state.epoch, previousEpoch, loggedOut: state.loggedOut });
}

export function readOfflineIdentity(): OfflineIdentity | null {
  const state = readState();
  return state.loggedOut || !state.identity ? null : { ...state.identity, user: { ...state.identity.user } };
}

export function offlineOwnerKey(identity: OfflineIdentity): string {
  return `${identity.user.id}:${identity.sessionVersion}:${identity.epoch}`;
}

export function assertOfflineIdentity(identity: OfflineIdentity): void {
  const current = readOfflineIdentity();
  if (!current || offlineOwnerKey(current) !== offlineOwnerKey(identity)) {
    throw new Error('登录身份已变化，请重新打开离线缓存');
  }
}

export function grantOfflineLease(identity: OfflineIdentity, expiresAt: string): void {
  assertOfflineIdentity(identity);
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('离线授权已过期，请联网重新下载');
  const state = readState();
  persist({ ...state, identity: { ...state.identity!, expiresAt: Math.max(state.identity!.expiresAt, expiry) } }, true);
}

/** Captured before requests; writes an initial generation so other tabs share it. */
export function offlineAuthEpoch(): string {
  const state = readState();
  if (observedRaw == null) persist(state);
  return state.epoch;
}

export function isOfflineLoggedOut(): boolean { return readState().loggedOut; }

export function isOfflineRouteAllowed(pathname: string): boolean {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/manage/offline-cache') return true;
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === '' && parts[1] === 'shows'
    && /^[1-9][0-9]*$/.test(parts[2]) && ['present', 'fullscreen', 'display'].includes(parts[3]);
}

/** Locks before asynchronous logout, account changes or purging old packages. */
export function lockOfflineIdentity(): OfflineIdentity | null {
  const previousEpoch = readState().epoch;
  const previous = readOfflineIdentity();
  persist({ epoch: newEpoch(), loggedOut: true, identity: null });
  notifySessionChange(previousEpoch);
  return previous;
}

/** A login response may clear the marker only for its original login attempt. */
export function beginOfflineLogin(): string {
  lockOfflineIdentity();
  return offlineAuthEpoch();
}

export function completeOfflineLogin(epoch: string): void {
  const state = readState();
  if (state.epoch !== epoch) throw new Error('登录请求已失效，请重新登录');
  persist({ ...state, loggedOut: false, identity: null });
  notifySessionChange();
}

/** Called only after a live /api/me response, never directly from a login payload. */
export function rememberOnlineIdentity(user: CurrentUser, requestEpoch: string): OfflineIdentity | null {
  const state = readState();
  if (state.epoch !== requestEpoch || state.loggedOut) throw new Error('登录身份已变化，请重试');
  const version = user.session_version;
  if (!Number.isSafeInteger(version) || !version || version < 1 || user.must_change_pwd) {
    persist({ ...state, identity: null });
    return null;
  }
  const sameOwner = state.identity?.user.id === user.id && state.identity?.sessionVersion === version;
  const epoch = state.identity && !sameOwner ? newEpoch() : state.epoch;
  const identity: OfflineIdentity = { user: snapshotUser(user, version), sessionVersion: version, epoch,
    expiresAt: sameOwner ? state.identity!.expiresAt : 0 };
  const saved = persist({ epoch, loggedOut: false, identity });
  if (epoch !== state.epoch || (!state.identity && saved)) notifySessionChange(state.epoch);
  return saved ? identity : null;
}

function onStorage(event: StorageEvent): void {
  if (event.key === OFFLINE_SESSION_KEY || event.key === null) {
    const state = readState();
    dispatch(OFFLINE_SESSION_EVENT, { remote: true, epoch: state.epoch });
    dispatch('slideflow-pwa-change', { remote: true });
  } else if (event.key === CHANGE_KEY) {
    let change: unknown;
    try { change = event.newValue ? JSON.parse(event.newValue) : null; } catch { /* An invalid signal grants no capabilities. */ }
    dispatch('slideflow-pwa-change', { ...safePwaChange(change), remote: true });
  }
}

function onBroadcast(event: MessageEvent): void {
  const message = event.data;
  if (!message || message.sender === tabId) return;
  if (message.type === 'session') {
    if (typeof message.epoch !== 'string' || !message.epoch || message.epoch.length > 160) return;
    const state = readState();
    if (storageReadable && state.epoch !== message.epoch && state.epoch !== message.previousEpoch) return;
    // Fail closed if shared storage cannot reflect a remote logout/account change.
    // A readable old value can also mean the sender's storage write failed.
    if (state.epoch !== message.epoch) persist({ epoch: message.epoch, loggedOut: true, identity: null });
    dispatch(OFFLINE_SESSION_EVENT, { remote: true, epoch: memory.epoch });
    dispatch('slideflow-pwa-change', { remote: true });
  } else if (message.type === 'cache') {
    dispatch('slideflow-pwa-change', { ...safePwaChange(message), remote: true });
  }
}

export function installOfflineSessionSync(): () => void {
  const target = window;
  syncUsers++;
  if (syncUsers === 1) {
    target.addEventListener('storage', onStorage);
    try { channel = new BroadcastChannel(CHANNEL_NAME); channel.onmessage = onBroadcast; } catch { channel = null; }
  }
  return () => {
    syncUsers = Math.max(0, syncUsers - 1);
    if (!syncUsers) { target.removeEventListener('storage', onStorage); channel?.close(); channel = null; }
  };
}

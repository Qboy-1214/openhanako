import React, { useEffect, useState, useCallback } from 'react';
import { marketApi, type DiscoverItem, type SharedAssetMeta } from '../../../shared/api/marketApi';
import { useStore } from '../../stores';

type MarketView = 'discover' | 'mine' | 'publish' | 'install';

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', color: 'var(--text-primary, #222)' },
  nav: { display: 'flex', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border, #e3e3e3)' },
  navBtn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border, #e3e3e3)', background: 'transparent', cursor: 'pointer', color: 'inherit' },
  navBtnActive: { background: 'var(--accent, #537D96)', color: '#fff', borderColor: 'transparent' },
  body: { flex: 1, overflowY: 'auto', padding: 16 },
  card: { border: '1px solid var(--border, #e3e3e3)', borderRadius: 10, padding: 12, marginBottom: 10 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  muted: { color: 'var(--text-muted, #888)', fontSize: 12 },
  input: { width: '100%', padding: '6px 8px', marginBottom: 8, borderRadius: 6, border: '1px solid var(--border, #e3e3e3)', boxSizing: 'border-box' },
  btn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--accent, #537D96)', background: 'var(--accent, #537D96)', color: '#fff', cursor: 'pointer' },
  btnGhost: { background: 'transparent', color: 'var(--accent, #537D96)' },
  err: { color: '#c0392b', fontSize: 13, marginBottom: 8 },
};

export function MarketPage() {
  const [view, setView] = useState<MarketView>('discover');
  const [discover, setDiscover] = useState<DiscoverItem[]>([]);
  const [mine, setMine] = useState<SharedAssetMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const setCurrentTab = useStore((s) => s.setCurrentTab);

  const refreshDiscover = useCallback(async () => {
    setLoading(true); setError(null);
    try { setDiscover(await marketApi.discover()); }
    catch (e: any) { setError(e?.message ?? 'discover failed'); }
    finally { setLoading(false); }
  }, []);

  const refreshMine = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMine(await marketApi.listMine()); }
    catch (e: any) { setError(e?.message ?? 'list failed'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (view === 'discover') refreshDiscover();
    if (view === 'mine') refreshMine();
  }, [view, refreshDiscover, refreshMine]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  const handleInstall = async (id: string) => {
    try { await marketApi.install(id); flash(`已安装 ${id}`); }
    catch (e: any) { setError(e?.message ?? 'install failed'); }
  };

  const handleUnpublish = async (id: string) => {
    try { await marketApi.unpublish(id); flash(`已下架 ${id}`); refreshMine(); }
    catch (e: any) { setError(e?.message ?? 'unpublish failed'); }
  };

  return (
    <div style={styles.root}>
      <div style={styles.nav}>
        {(['discover', 'mine', 'publish', 'install'] as MarketView[]).map((v) => (
          <button
            key={v}
            style={{ ...styles.navBtn, ...(view === v ? styles.navBtnActive : {}) }}
            onClick={() => setView(v)}
          >
            {v === 'discover' ? '发现' : v === 'mine' ? '我的发布' : v === 'publish' ? '发布' : '安装'}
          </button>
        ))}
      </div>
      <div style={styles.body}>
        {error ? <div style={styles.err}>{error}</div> : null}
        {toast ? <div style={{ ...styles.muted, color: '#2e7d32' }}>{toast}</div> : null}

        {view === 'discover' && (
          <DiscoverView items={discover} loading={loading} onInstall={handleInstall} />
        )}
        {view === 'mine' && (
          <MineView items={mine} loading={loading} onUnpublish={handleUnpublish} />
        )}
        {view === 'publish' && (
          <PublishView onPublished={() => { flash('已发布'); setView('mine'); refreshMine(); }} onError={setError} />
        )}
        {view === 'install' && (
          <InstallView mine={mine} discover={discover} onInstall={handleInstall} onGotoDiscover={() => setView('discover')} />
        )}
      </div>
    </div>
  );
}

function DiscoverView({ items, loading, onInstall }: { items: DiscoverItem[]; loading: boolean; onInstall: (id: string) => void }) {
  if (loading) return <div style={styles.muted}>加载中…</div>;
  if (!items.length) return <div style={styles.muted}>暂无分享资产</div>;
  return (
    <>
      {items.map((it) => (
        <div key={it.id} style={styles.card}>
          <div style={styles.row}>
            <strong>{it.title}</strong>
            <button style={styles.btn} onClick={() => onInstall(it.id)}>安装</button>
          </div>
          <div style={styles.muted}>{it.kind} · @{it.ownerHandle} · 安装 {it.installCount}</div>
          <div style={{ marginTop: 4 }}>{it.summary}</div>
        </div>
      ))}
    </>
  );
}

function MineView({ items, loading, onUnpublish }: { items: SharedAssetMeta[]; loading: boolean; onUnpublish: (id: string) => void }) {
  if (loading) return <div style={styles.muted}>加载中…</div>;
  if (!items.length) return <div style={styles.muted}>你还没有发布任何资产</div>;
  return (
    <>
      {items.map((it) => (
        <div key={it.id} style={styles.card}>
          <div style={styles.row}>
            <strong>{it.title}</strong>
            <button style={{ ...styles.btn, ...styles.btnGhost }} onClick={() => onUnpublish(it.id)}>下架</button>
          </div>
          <div style={styles.muted}>{it.kind} · {it.id} · 安装 {it.installCount}</div>
          <div style={{ marginTop: 4 }}>{it.summary}</div>
        </div>
      ))}
    </>
  );
}

function PublishView({ onPublished, onError }: { onPublished: () => void; onError: (e: string | null) => void }) {
  const [kind, setKind] = useState<'tool' | 'workflow'>('tool');
  const [sourceId, setSourceId] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!sourceId || !title) { onError('sourceId 与 title 必填'); return; }
    setBusy(true); onError(null);
    try {
      await marketApi.publish({ kind, sourceId, title, summary, homepageUrl: homepageUrl || undefined });
      onPublished();
    } catch (e: any) { onError(e?.message ?? 'publish failed'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <select style={styles.input} value={kind} onChange={(e) => setKind(e.target.value as any)}>
        <option value="tool">tool</option>
        <option value="workflow">workflow</option>
      </select>
      <input style={styles.input} placeholder="sourceId（工具/工作流本地 id）" value={sourceId} onChange={(e) => setSourceId(e.target.value)} />
      <input style={styles.input} placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input style={styles.input} placeholder="summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
      <input style={styles.input} placeholder="homepageUrl（可选）" value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} />
      <button style={styles.btn} disabled={busy} onClick={submit}>{busy ? '发布中…' : '发布'}</button>
    </div>
  );
}

function InstallView({ mine, discover, onInstall, onGotoDiscover }: {
  mine: SharedAssetMeta[]; discover: DiscoverItem[]; onInstall: (id: string) => void; onGotoDiscover: () => void;
}) {
  const installed = new Set(mine.map((m) => m.id));
  const candidates = discover.filter((d) => !installed.has(d.id));
  if (!candidates.length) {
    return <div style={styles.muted}>没有可安装的新资产。<button style={{ ...styles.btn, ...styles.btnGhost }} onClick={onGotoDiscover}>去发现</button></div>;
  }
  return (
    <>
      {candidates.map((it) => (
        <div key={it.id} style={styles.card}>
          <div style={styles.row}>
            <strong>{it.title}</strong>
            <button style={styles.btn} onClick={() => onInstall(it.id)}>安装</button>
          </div>
          <div style={styles.muted}>{it.kind} · @{it.ownerHandle}</div>
          <div style={{ marginTop: 4 }}>{it.summary}</div>
        </div>
      ))}
    </>
  );
}

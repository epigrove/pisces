// dsh-ashu-chat —— 左栏「Pisces 聊天」面板
//
// 一个入口、一个会话、直接收发。
// 不做会话管理、不删除任何东西——「新建会话」只是在我这边开一个干净的上下文并固定为
// 投递目标，旧会话原样留着。
window.__ModuleLoader__.load({
  id: 'dsh-ashu-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'pisces-chat';
    const NS = 'piscesChat';

    const DICT = {
      zh: {
        nav: 'Pisces 聊天', title: 'Pisces 聊天', sub: '与 koi 的对话',
        none: '会话还没建好（插件会自动创建并固定），稍等刷新。',
        sending: '发送中…', send: '发送', attach: '发文件', uploading: '上传中…', sent: '已发送',
        hint: '这条线是你和她直接说话。她的回复会落在这里；我跟她的对话是另一条，不会混进来。',
        fileTooBig: '文件太大（上限 20MB）', uploadFail: '上传失败',
        placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
        empty: '还没有消息。发一条试试。',
        loading: '加载中…', loadFail: '加载失败', retry: '重试',
        master: 'master', koi: 'koi',
      },
      en: {
        nav: 'Pisces Chat', title: 'Pisces Chat', sub: 'Conversation with koi',
        none: 'Session not ready yet — the plugin creates and pins one automatically.',
        sending: 'Sending…', send: 'Send', attach: 'Attach', uploading: 'Uploading…', sent: 'Sent',
        hint: 'A direct line from you to her. Her replies land here; my conversation with her is separate.',
        fileTooBig: 'File too large (20MB max)', uploadFail: 'Upload failed',
        placeholder: 'Say something… (Enter to send, Shift+Enter for newline)',
        empty: 'No messages yet. Try sending one.',
        loading: 'Loading…', loadFail: 'Load failed', retry: 'Retry',
        master: 'master', koi: 'koi',
      },
    };

    const api = (p, o) => fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o }).then((r) => r.json());
    const fmt = (ts, lang) => ts ? new Date(ts).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '';

    const CSS = `
      /* 2026-11-16：原来 .kc-root 既是滚动容器又限宽 680px，滚动条就卡在屏幕中间。
         改成外层 .kc-scroll 负责滚动（占满可用宽度，滚动条贴边），
         内层 .kc-root 只负责限宽，滚动条永远在最右侧。 */
      .kc-scroll{height:100%;overflow-y:auto;overflow-x:hidden;color:inherit;font-size:14px}
      .kc-scroll::-webkit-scrollbar{width:10px}
      .kc-scroll::-webkit-scrollbar-track{background:transparent}
      .kc-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;border:3px solid transparent;background-clip:content-box}
      .kc-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,currentColor 32%,transparent);border:3px solid transparent;background-clip:content-box}
      .kc-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 18%,transparent) transparent}
      .kc-root{max-width:1080px;margin:0 auto;padding:24px clamp(16px,4vw,48px) 32px;box-sizing:border-box}
      .kc-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:16px;padding:20px 22px;margin:18px 0;background:color-mix(in srgb,currentColor 3%,transparent);transition:border-color .2s,box-shadow .2s}
      .kc-card:hover{border-color:color-mix(in srgb,currentColor 22%,transparent)}
      .kc-h{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:15px;font-weight:600}
      .kc-dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#ff7a45,#e8447a);box-shadow:0 0 10px color-mix(in srgb,#ff7a45 60%,transparent)}
      .kc-row{display:flex;align-items:center;gap:12px;margin:10px 0}
      .kc-lab{width:76px;flex-shrink:0;opacity:.65;font-size:13px}
      .kc-select,.kc-input{flex:1;min-width:0;appearance:none;background:color-mix(in srgb,currentColor 5%,transparent);border:1px solid color-mix(in srgb,currentColor 16%,transparent);color:inherit;border-radius:10px;padding:9px 12px;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
      .kc-select:focus,.kc-input:focus{border-color:#ff7a45;box-shadow:0 0 0 3px color-mix(in srgb,#ff7a45 22%,transparent)}
      .kc-select:disabled{opacity:.45}
      .kc-seg{display:flex;gap:4px;background:color-mix(in srgb,currentColor 6%,transparent);border-radius:12px;padding:4px}
      .kc-seg button{flex:1;border:none;border-radius:9px;padding:8px 10px;font-size:13px;cursor:pointer;background:transparent;color:inherit;opacity:.7;transition:all .18s}
      .kc-seg button.on{background:linear-gradient(135deg,#ff7a45,#e8447a);color:#fff;opacity:1;box-shadow:0 2px 10px color-mix(in srgb,#e8447a 40%,transparent)}
      .kc-btn{border:none;border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#ff7a45,#e8447a);color:#fff;transition:transform .12s,box-shadow .2s;box-shadow:0 2px 12px color-mix(in srgb,#e8447a 35%,transparent)}
      .kc-btn:hover{transform:translateY(-1px);box-shadow:0 4px 16px color-mix(in srgb,#e8447a 50%,transparent)}
      .kc-btn:active{transform:translateY(0)}
      .kc-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:4px 12px;background:color-mix(in srgb,#ff7a45 12%,transparent);color:color-mix(in srgb,#ff7a45 80%,currentColor);border:1px solid color-mix(in srgb,#ff7a45 30%,transparent)}
      .kc-note{font-size:12px;opacity:.55;margin-top:10px;line-height:1.5}
      .kc-toast{position:sticky;top:0;z-index:5;margin:0 0 8px;border-radius:10px;padding:8px 14px;font-size:13px;background:color-mix(in srgb,#22c55e 14%,transparent);color:color-mix(in srgb,#22c55e 80%,currentColor);border:1px solid color-mix(in srgb,#22c55e 35%,transparent)}
      .kc-head{display:flex;align-items:center;gap:14px;margin-bottom:6px}
      .kc-logo{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff7a45,#e8447a);box-shadow:0 4px 18px color-mix(in srgb,#e8447a 45%,transparent)}
      .kc-title{font-size:20px;font-weight:700;margin:0}
      .kc-sub{font-size:12px;opacity:.55;margin:2px 0 0}
      /* ── 以下是聊天面板专用（其余与「Pisces 配置」完全一致）── */
      .kc-root{display:flex;flex-direction:column;height:100%;min-height:0}
      .kc-msgs{flex:1;min-height:0;overflow-y:auto;padding:2px;margin:2px 0 10px;display:flex;flex-direction:column;gap:8px}
      .kc-msgs::-webkit-scrollbar{width:8px}
      .kc-msgs::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 16%,transparent);border-radius:8px}
      .kc-msg{display:flex;flex-direction:column;max-width:86%}
      .kc-msg.koi{align-self:flex-start}
      .kc-msg.ashu{align-self:flex-end;align-items:flex-end}
      .kc-bubble{border-radius:14px;padding:9px 13px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
      .kc-msg.koi .kc-bubble{background:color-mix(in srgb,currentColor 7%,transparent);border:1px solid color-mix(in srgb,currentColor 10%,transparent)}
      .kc-msg.ashu .kc-bubble{background:linear-gradient(135deg,#ff7a45,#e8447a);color:#fff}
      .kc-meta{font-size:11px;opacity:.45;margin:3px 4px 0}
      .kc-file{display:inline-flex;align-items:center;gap:8px;font-size:12px;border-radius:10px;padding:6px 10px;margin-top:6px;background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid color-mix(in srgb,currentColor 14%,transparent);text-decoration:none;color:inherit}
      .kc-file:hover{border-color:#ff7a45}
      .kc-file b{font-weight:600}
      .kc-file span{opacity:.55}
      .kc-attach{border:none;border-radius:10px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;background:color-mix(in srgb,currentColor 8%,transparent);color:inherit;border:1px solid color-mix(in srgb,currentColor 16%,transparent)}
      .kc-attach:disabled{opacity:.5;cursor:default}
      .kc-in{flex:1;min-width:0;resize:none;background:color-mix(in srgb,currentColor 5%,transparent);border:1px solid color-mix(in srgb,currentColor 16%,transparent);color:inherit;border-radius:10px;padding:9px 12px;font:inherit;font-size:13px;outline:none;max-height:140px;line-height:1.5}
      .kc-in:focus{border-color:#ff7a45;box-shadow:0 0 0 3px color-mix(in srgb,#ff7a45 22%,transparent)}
      .kc-chip.off{border-color:color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;opacity:.6}
      .kc-note{font-size:12px;opacity:.55;margin-top:10px;line-height:1.5}

      /* ── 2026-11-16 A 案：对齐 DSH 会话的观感 ──
         不引入 DSH 组件，只把硬编码颜色换它的设计变量——
         主题切换（明/暗）自动跟随，和主会话区看起来是一套。 */
      .kc-scroll{font-family:var(--dsw-font-family,inherit)}
      .kc-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,color-mix(in srgb,currentColor 18%,transparent));border-radius:var(--dsw-radius-sm,8px)}
      .kc-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,color-mix(in srgb,currentColor 32%,transparent))}
      .kc-card{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));background:var(--dsw-alias-bg-base,color-mix(in srgb,currentColor 3%,transparent));border-radius:var(--dsw-radius-panel,16px)}
      .kc-card:hover{border-color:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent))}
      .kc-title{color:var(--dsw-alias-label-primary,inherit)}
      .kc-sub,.kc-note,.kc-meta{color:var(--dsw-alias-label-tertiary,inherit)}
      .kc-msgs::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px)}
      .kc-bubble{font-family:var(--dsw-font-family,inherit)}
      .kc-msg.koi .kc-bubble{background:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 7%,transparent));border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent));border-radius:var(--dsw-radius-lg,14px);color:var(--dsw-alias-label-primary,inherit)}
      .kc-msg.ashu .kc-bubble{border-radius:var(--dsw-radius-lg,14px)}
      .kc-in,.kc-select{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,color-mix(in srgb,currentColor 5%,transparent));border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-label-primary,inherit)}
      .kc-in:focus{border-color:var(--dsw-alias-button-info-fill,#ff7a45)}
      .kc-file{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));background:var(--dsw-alias-bg-module-platform,transparent);border-radius:var(--dsw-radius-sm,10px);color:var(--dsw-alias-label-secondary,inherit)}
      .kc-attach{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,transparent);border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-label-secondary,inherit)}
      .kc-toast{background:color-mix(in srgb,#22c55e 14%,transparent);border-color:color-mix(in srgb,#22c55e 35%,transparent)}
    `;

    function KoiLogo({ size = 24, body = '#fff', eye = '#e8447a' }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
        h('path', { fill: body, d: 'M12 5c-4.5 0-8 3-9.5 7 1.5 4 5 7 9.5 7s8-3 9.5-7C20 8 16.5 5 12 5zm0 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z' }),
        h('circle', { cx: 12, cy: 12, r: 1.6, fill: eye }));
    }
    function Icon() {
      return h('span', { style: { display: 'inline-flex' } }, h(KoiLogo, { size: 18, body: '#ff7a45', eye: '#e8447a' }));
    }

    function Panel({ t, lang }) {
      const [st, setSt] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [uploading, setUploading] = React.useState(false);
      const fileRef = React.useRef(null);
      const boxRef = React.useRef(null);

      const load = () => api('/pisces-chat/state')
        .then((s) => { setSt(s); setErr(''); })
        .catch((e) => setErr(String(e)));

      React.useEffect(() => { load(); }, []);
      // 5 秒轮询：她回消息没有推送通道，只能拉
      React.useEffect(() => {
        const id = setInterval(() => { load(); }, 5000);
        return () => clearInterval(id);
      }, []);
      React.useEffect(() => { if (!msg) return; const id = setTimeout(() => setMsg(''), 2200); return () => clearTimeout(id); }, [msg]);
      // 新消息进来滚到底
      React.useEffect(() => {
        const el = boxRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [st && st.messages ? st.messages.length : 0]);

      const doSend = () => {
        const body = text.trim();
        if (body === '' || busy) return;
        setBusy(true);
        api('/pisces-chat/send', { method: 'POST', body: JSON.stringify({ text: body }) })
          .then((r) => { if (!r.ok) setErr(r.error || 'send failed'); else setText(''); return load(); })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      };

      // 发文件：读成 base64 传给后端，由它存进她的 workspace/uploads
      const doUpload = (file) => {
        if (!file || uploading || busy) return;
        if (file.size > 20 * 1024 * 1024) { setErr(t('fileTooBig')); return; }
        setUploading(true);
        const reader = new FileReader();
        reader.onload = () => {
          const data = String(reader.result || '').split(',')[1] || '';
          api('/pisces-chat/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data, text: text.trim() }) })
            .then((r) => { if (!r.ok) setErr(`${t('uploadFail')}: ${r.error}`); else { setText(''); setMsg(t('sent')); } return load(); })
            .catch((e) => setErr(String(e)))
            .finally(() => { setUploading(false); if (fileRef.current) fileRef.current.value = ''; });
        };
        reader.onerror = () => { setErr(t('uploadFail')); setUploading(false); };
        reader.readAsDataURL(file);
      };

      if (err) return h('div', { className: 'kc-scroll' }, h('style', null, CSS),
        h('div', { className: 'kc-root' }, h('div', { className: 'kc-card' }, t('loadFail'), ': ', err,
          h('div', { style: { marginTop: 12 } }, h('button', { className: 'kc-btn', onClick: load }, t('retry'))))));
      if (!st) return h('div', { className: 'kc-scroll' }, h('style', null, CSS), h('div', { className: 'kc-root' }, h('div', { className: 'kc-note' }, t('loading'), '…')));

      const list = st.messages ?? [];

      return h('div', { className: 'kc-scroll' },
        h('style', null, CSS),
        h('div', { className: 'kc-root' },
          msg && h('div', { className: 'kc-toast' }, msg),
          h('div', { className: 'kc-head' },
            h('div', { className: 'kc-logo' }, h(KoiLogo, { size: 26 })),
            h('div', null, h('h2', { className: 'kc-title' }, t('title')), h('div', { className: 'kc-sub' }, t('sub')))),
          h('div', { className: 'kc-card' },
            h('div', { className: 'kc-note', style: { margin: 0 } }, t('hint'))),
          h('div', { className: 'kc-msgs', ref: boxRef },
            list.length === 0
              ? h('div', { className: 'kc-note' }, t('empty'))
              : list.map((m, i) => h('div', { key: `${m.at}-${i}`, className: 'kc-msg ' + (m.from === 'koi' ? 'koi' : 'ashu') },
                h('div', { className: 'kc-bubble' }, m.text),
                m.file ? h('a', {
                  className: 'kc-file',
                  href: `/pisces-chat/file?rel=${encodeURIComponent(m.file.rel ?? '')}`,
                  target: '_blank', rel: 'noreferrer', download: m.file.name,
                }, h('b', null, m.file.name), h('span', null, `${((m.file.size ?? 0) / 1024).toFixed(0)}KB`)) : null,
                h('div', { className: 'kc-meta' }, `${m.from === 'koi' ? t('koi') : t('master')} · ${fmt(m.at, lang)}`)))),
          h('div', { className: 'kc-row', style: { alignItems: 'flex-end' } },
            h('input', {
              ref: fileRef, type: 'file', style: { display: 'none' },
              onChange: (e) => doUpload(e.target.files && e.target.files[0]),
            }),
            h('button', {
              className: 'kc-attach',
              onClick: () => fileRef.current && fileRef.current.click(),
              disabled: uploading || busy,
              title: t('attach'),
            }, uploading ? t('uploading') : t('attach')),
            h('textarea', {
              className: 'kc-in', rows: 1, value: text, placeholder: t('placeholder'),
              onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } },
            }),
            h('button', { className: 'kc-btn', onClick: doSend, disabled: busy || text.trim() === '' }, busy ? t('sending') : t('send'))))
        );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const hasLocale = ctx.locale && typeof ctx.locale.getLocale === 'function';
        if (hasLocale) ctx.effect(() => {
          const dz = ctx.locale.register(NS, 'zh', DICT.zh);
          const de = ctx.locale.register(NS, 'en', DICT.en);
          return () => { dz(); de(); };
        }, 'piscesChat: dictionaries');
        const lang = () => {
          const a = hasLocale ? ctx.locale.getLocale().active
            : (typeof navigator !== 'undefined' ? navigator.language : 'en');
          return /^zh/i.test(String(a)) ? 'zh' : 'en';
        };

        let stopMain, stopSide;
        const mount = () => {
          stopMain?.(); stopSide?.();
          const L = lang();
          const tt = (k) => (DICT[L] || DICT.en)[k] ?? k;
          stopMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { t: tt, lang: L })));
          stopSide = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => tt('nav'), locale: NS }, Icon));
        };
        ctx.effect(() => {
          mount();
          const un = hasLocale ? ctx.locale.subscribe(mount) : () => {};
          return () => { un(); stopMain?.(); stopSide?.(); };
        }, 'piscesChat: panel slots');
      },
    };
  },
});

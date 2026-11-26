// dsh-pisces-panel —— GUI 左栏「Pisces 配置」面板
// v3（2026-11-14）：
//   · 文案随宿主语言切换（ctx.locale register/bind/subscribe），不再中英同显
//   · 删「其它默认」节
//   · 现代化视觉：koi 暖橙 accent + 宿主主题中性色（currentColor/color-mix 自适应明暗）
// 席位契约与 im-qqbot 相同：sidebar.panellist + main(keyed)。
window.__ModuleLoader__.load({
  // 这个 id 必须与 package.json 的 name 完全一致：宿主按 manifest 的模块 id
  // 来这里找 factory，对不上就永远不 apply（左栏入口消失且无报错）。
  // 2026-11-16 事故：改名时 sed 把这里留成了 'dsh-pisces'。
  id: 'dsh-pisces-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'pisces-config';
    const NS = 'pisces';

    const DICT = {
      zh: {
        nav: 'Pisces 配置', title: 'Pisces 配置', sub: 'koi 与 ashu 的框架配置',
        api: 'API 与模型', mode: '来源', follow: '跟随最近活跃会话', fixed: '固定模型', manual: '手动配置',
        provider: '提供方', model: '模型', live: '当前生效', apiNote: '只作用于 koi，不改 ashu 的共享配置。跟随=跟最近活跃会话；固定=用下面选的；手动=在会话里选。',
        manualNote: '手动模式下，模型在会话里选。已经配过的会话不会被改动——要改它们得手动编辑配置文件，这里不提供入口。',
        proposal: 'koi 的消息投递到（ashu 的会话）', proposalNote: '列表是 ashu 这边的会话。koi 发来的消息与回复会固定投递到你选定的这一个；选「自动」则跟随你最后说话的主会话。',
        auto: '自动 · 你最后说话的主会话', session: 'ashu 的会话', lastHuman: '最后发言',
        plugins: '她的插件',
        pluginsNote: '关掉的插件会写进她的配置，重启 koi 后生效。标「库」的始终启用，关不了。',
        pluginsDeps: '插件之间的依赖：',
        cat_memory: '记忆与印象', cat_talk: '对话与媒体', cat_rhythm: '节奏', cat_safety: '安全',
        cat_base: '基础库', cat_gate: '出口与门控', cat_other: '其他',
        lib: '库', turnOn: '打开', turnOff: '关闭',
        needRestart: '已保存，重启 koi 后生效', blocked: '依赖被关：',
        on: '开', off: '关',
        identity: '身份文件（名字与主人称呼）',
        identityNote: '面板不改这个文件。按系统给出写法，点一下可全选复制。',
        save: '保存更改', saved: '已保存', loading: '加载中', loadFail: '加载失败', retry: '重试',
      },
      en: {
        nav: 'Pisces Config', title: 'Pisces Config', sub: 'Framework config for koi and ashu',
        api: 'API & Model', mode: 'Source', follow: 'Follow latest active session', fixed: 'Fixed model', manual: 'Manual',
        provider: 'Provider', model: 'Model', live: 'Active', apiNote: "Applies to koi only; ashu's shared config is untouched. Follow = latest active session; Fixed = the one below; Manual = pick in a session.",
        manualNote: 'In manual mode the model is chosen inside a session. Sessions already configured are left alone — to change those, edit the config file; there is no entry here.',
        proposal: "Deliver koi's messages to (ashu's session)", proposalNote: "Sessions on ashu's side. koi's messages and replies are pinned to the one you pick; “Auto” follows the main session where you last spoke.",
        auto: 'Auto · main session where you last spoke', session: "ashu's session", lastHuman: 'last spoke',
        plugins: "koi's plugins",
        pluginsNote: 'Toggles are written to her config and take effect after a koi restart. Libraries (marked) are always on.',
        pluginsDeps: 'Dependencies between toggleable plugins: ',
        cat_memory: 'Memory & impressions', cat_talk: 'Talk & media', cat_rhythm: 'Rhythm', cat_safety: 'Safety',
        cat_base: 'Foundation', cat_gate: 'Outbound & gating', cat_other: 'Other',
        lib: 'library', turnOn: 'Turn on', turnOff: 'Turn off',
        needRestart: 'Saved — takes effect after koi restarts', blocked: 'Dependency off: ',
        identity: 'Identity file (name & master title)',
        identityNote: 'Not editable here. Path per OS — click to select.',
        save: 'Save changes', saved: 'Saved', loading: 'Loading', loadFail: 'Load failed', retry: 'Retry',
      },
    };

    const api = (p, o) => fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o }).then((r) => r.json());
    const fmt = (ts, lang) => ts ? new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    // 组件级样式：随卸载移除；用 currentColor/color-mix 继承宿主明暗主题。
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

      /* ── 2026-11-16：改为调用 DSH 设计变量，和主会话区同一套观感 ── */
      .kc-scroll{font-family:var(--dsw-font-family,inherit)}
      .kc-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,color-mix(in srgb,currentColor 18%,transparent))}
      .kc-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,color-mix(in srgb,currentColor 32%,transparent))}
      .kc-card{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));background:var(--dsw-alias-bg-base,color-mix(in srgb,currentColor 3%,transparent));border-radius:var(--dsw-radius-panel,16px)}
      .kc-card:hover{border-color:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent))}
      .kc-title{color:var(--dsw-alias-label-primary,inherit)}
      .kc-sub,.kc-note,.kc-meta{color:var(--dsw-alias-label-tertiary,inherit)}
      .kc-h{color:var(--dsw-alias-label-primary,inherit)}
      .kc-lab{color:var(--dsw-alias-label-secondary,inherit)}
      .kc-select,.kc-input{border-color:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));background:var(--dsw-alias-bg-base,color-mix(in srgb,currentColor 5%,transparent));border-radius:var(--dsw-radius-md,10px);color:var(--dsw-alias-label-primary,inherit)}
      .kc-select:focus,.kc-input:focus{border-color:var(--dsw-alias-button-info-fill,#ff7a45)}
      .kc-seg{background:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 6%,transparent));border-radius:var(--dsw-radius-md,12px)}
      .kc-chip{border-radius:var(--dsw-radius-lg,999px);background:var(--dsw-alias-bg-module-platform,color-mix(in srgb,#ff7a45 12%,transparent));color:var(--dsw-alias-label-secondary,inherit);border-color:var(--dsw-alias-border-l2,transparent)}
      .kc-toast{background:color-mix(in srgb,#22c55e 14%,transparent);border-color:color-mix(in srgb,#22c55e 35%,transparent)}
      /* 右下角浮动保存条：只在有改动时出现 */
      .kc-savebar{position:fixed;right:32px;bottom:28px;z-index:20;display:flex;gap:10px;align-items:center;
        padding:10px 12px;border-radius:var(--dsw-radius-panel,16px);
        background:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 6%,transparent));
        border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));
        box-shadow:0 8px 28px color-mix(in srgb,#000 22%,transparent)}

      /* ── 插件列表：照 WebUI 插件页的版式（图标 + 主标题 + 副标题 + 右侧开关）── */
      .kc-pnote{font-size:12px;color:var(--dsw-alias-label-tertiary,currentColor);opacity:.9;line-height:1.6;margin:0 0 4px}
      .kc-pgroup{margin-top:18px}
      .kc-phead{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,currentColor);margin:0 0 2px 2px}
      .kc-prow{display:flex;align-items:center;gap:14px;padding:12px 2px;border-radius:12px}
      .kc-prow:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 4%,transparent))}
      .kc-picon{width:38px;height:38px;flex:none;border-radius:11px;display:flex;align-items:center;justify-content:center;
        font-size:15px;font-weight:600;color:#fff;background:linear-gradient(135deg,#7c8cff,#5b6ef5)}
      .kc-picon[data-cat="memory"]{background:linear-gradient(135deg,#ff8f5a,#e8447a)}
      .kc-picon[data-cat="talk"]{background:linear-gradient(135deg,#4ab3ff,#2f7cf6)}
      .kc-picon[data-cat="rhythm"]{background:linear-gradient(135deg,#9b8cff,#6f5bf0)}
      .kc-picon[data-cat="safety"]{background:linear-gradient(135deg,#3fd08a,#1fa76a)}
      .kc-picon[data-cat="gate"]{background:linear-gradient(135deg,#9aa3b2,#6b7482)}
      .kc-picon[data-cat="base"]{background:linear-gradient(135deg,#b0b7c3,#848c99)}
      .kc-pmain{flex:1;min-width:0}
      .kc-ptitle{display:flex;align-items:baseline;gap:8px;min-width:0}
      .kc-ppkg{font-size:11.5px;color:var(--dsw-alias-label-tertiary,currentColor);opacity:.85;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
      .kc-prow:hover .kc-ppkg{opacity:1}
      .kc-pname{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,currentColor);line-height:1.35}
      .kc-pdesc{font-size:12.5px;color:var(--dsw-alias-label-tertiary,currentColor);margin-top:3px;line-height:1.45;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .kc-pdesc.warn{color:color-mix(in srgb,#f59e0b 85%,currentColor)}
      .kc-pbadge{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,currentColor);
        border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));
        border-radius:999px;padding:3px 10px}
      .kc-switch{flex:none;width:42px;height:24px;border-radius:999px;border:none;cursor:pointer;position:relative;
        background:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 25%,transparent));transition:background .18s}
      .kc-switch i{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;
        box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s}
      .kc-switch.on{background:linear-gradient(135deg,#ff7a45,#e8447a)}
      .kc-switch.on i{transform:translateX(18px)}
      .kc-switch.blocked,.kc-switch:disabled{opacity:.45;cursor:not-allowed}
    `;

    function KoiLogo({ size = 24, body = '#fff', eye = '#e8447a' }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
        h('path', { fill: body, d: 'M12 5c-4.5 0-8 3-9.5 7 1.5 4 5 7 9.5 7s8-3 9.5-7C20 8 16.5 5 12 5zm0 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z' }),
        h('circle', { cx: 12, cy: 12, r: 1.6, fill: eye }));
    }
    // 左栏图标：用 koi 暖橙（明暗主题都看得清），不再用白色（浅色下 invisible）。
    function Icon() {
      return h('span', { style: { display: 'inline-flex' } }, h(KoiLogo, { size: 18, body: '#ff7a45', eye: '#e8447a' }));
    }

    function Panel({ t, lang }) {
      const [st, setSt] = React.useState(null);
      const [models, setModels] = React.useState([]);
      const [sessions, setSessions] = React.useState([]);
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [apiF, setApiF] = React.useState({ mode: 'follow', provider: '', model: '' });
      const [prop, setProp] = React.useState({ sessionId: '' });
      const [base, setBase] = React.useState(null);
      const [plugins, setPlugins] = React.useState([]);
      const [pluginBusy, setPluginBusy] = React.useState('');

      const load = () => Promise.all([
        api('/pisces/state'), api('/pisces/models'), api('/pisces/sessions'), api('/pisces/plugins'),
      ]).then(([s, m, ss, pl]) => {
        if (!Array.isArray(ss)) throw new Error(ss?.error || 'sessions response is not an array');
        setPlugins(Array.isArray(pl) ? pl : []);
        setSt(s); setModels(m); setSessions(ss); setErr('');
        setApiF({ mode: s.api.mode, provider: s.api.provider, model: s.api.model });
        setProp({ sessionId: s.proposal.sessionId });
        setBase({ api: { mode: s.api.mode, provider: s.api.provider, model: s.api.model }, prop: { sessionId: s.proposal.sessionId } });
      }).catch((e) => setErr(String(e)));
      React.useEffect(() => { load(); }, []);
      React.useEffect(() => { if (!msg) return; const id = setTimeout(() => setMsg(''), 2200); return () => clearTimeout(id); }, [msg]);

      const save = (body) => api('/pisces/override', { method: 'POST', body: JSON.stringify(body) })
        .then((r) => { setMsg(r.ok ? t('saved') : (r.error || 'fail')); return load(); })
        .catch((e) => setErr(String(e)));

      // 只有真有改动才显示右下角的保存按钮
      const togglePlugin = (id, enabled, revision) => {
        if (pluginBusy) return;
        setPluginBusy(id);
        api('/pisces/plugins/toggle', { method: 'POST', body: JSON.stringify({ id, enabled, revision }) })
          .then((r) => {
            if (!r.ok) {
              setMsg(r.error || 'fail');
              if (r.conflict) load();
              return;
            }
            setPlugins(r.plugins ?? []);
            setMsg(t('needRestart'));
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setPluginBusy(''));
      };

      const dirty = base !== null
        && (JSON.stringify(apiF) !== JSON.stringify(base.api) || JSON.stringify(prop) !== JSON.stringify(base.prop));
      const saveAll = () => {
        const body = {};
        if (JSON.stringify(apiF) !== JSON.stringify(base.api)) body.api = apiF;
        if (JSON.stringify(prop) !== JSON.stringify(base.prop)) body.proposal = prop;
        if (Object.keys(body).length > 0) save(body);
      };

      if (err) return h('div', { className: 'kc-scroll' }, h('style', null, CSS),
        h('div', { className: 'kc-root' }, h('div', { className: 'kc-card' }, t('loadFail'), ': ', err, h('div', { style: { marginTop: 12 } }, h('button', { className: 'kc-btn', onClick: load }, t('retry'))))));
      if (!st) return h('div', { className: 'kc-scroll' }, h('style', null, CSS), h('div', { className: 'kc-root' }, h('div', { className: 'kc-note' }, t('loading'), '…')));

      const provModels = (models.find((x) => x.provider === apiF.provider) || {}).models || [];

      return h('div', { className: 'kc-scroll' },
        h('style', null, CSS),
        h('div', { className: 'kc-root' },
        msg && h('div', { className: 'kc-toast' }, msg),
        h('div', { className: 'kc-head' },
          h('div', { className: 'kc-logo' }, h(KoiLogo, { size: 26 })),
          h('div', null, h('h2', { className: 'kc-title' }, t('title')), h('div', { className: 'kc-sub' }, t('sub')))),

        h('section', { className: 'kc-card' },
          h('h3', { className: 'kc-h' }, h('span', { className: 'kc-dot' }), t('api')),
          h('div', { className: 'kc-seg' },
            h('button', { className: apiF.mode === 'follow' ? 'on' : '', onClick: () => setApiF({ ...apiF, mode: 'follow' }) }, t('follow')),
            h('button', { className: apiF.mode === 'fixed' ? 'on' : '', onClick: () => setApiF({ ...apiF, mode: 'fixed' }) }, t('fixed')),
            h('button', { className: apiF.mode === 'manual' ? 'on' : '', onClick: () => setApiF({ ...apiF, mode: 'manual' }) }, t('manual'))),
          apiF.mode === 'manual' && h('div', { className: 'kc-note' }, t('manualNote')),
          apiF.mode === 'fixed' && h('div', null,
            h('div', { className: 'kc-row' }, h('span', { className: 'kc-lab' }, t('provider')),
              h('select', { className: 'kc-select', value: apiF.provider, onChange: (e) => setApiF({ ...apiF, provider: e.target.value, model: (models.find((x) => x.provider === e.target.value) || {}).models?.[0]?.id ?? '' }) },
                models.map((x) => h('option', { key: x.provider, value: x.provider }, x.provider)))),
            h('div', { className: 'kc-row' }, h('span', { className: 'kc-lab' }, t('model')),
              h('select', { className: 'kc-select', value: apiF.model, onChange: (e) => setApiF({ ...apiF, model: e.target.value }) },
                provModels.map((m) => h('option', { key: m.id, value: m.id }, m.name))))),
          h('div', { className: 'kc-row' }, h('span', { className: 'kc-lab' }, t('live')), h('span', { className: 'kc-chip' }, `${st.api.live.provider} / ${st.api.live.model}`)),
          h('div', { className: 'kc-note' }, t('apiNote')),
          null),

        h('section', { className: 'kc-card' },
          h('h3', { className: 'kc-h' }, h('span', { className: 'kc-dot' }), t('proposal')),
          h('div', { className: 'kc-row' }, h('span', { className: 'kc-lab' }, t('session')),
            h('select', { className: 'kc-select', value: prop.sessionId, onChange: (e) => setProp({ sessionId: e.target.value }) },
              h('option', { value: '' }, t('auto')),
              sessions.map((s) => h('option', { key: s.id, value: s.id }, `${s.id.slice(8, 16)}… · ${t('lastHuman')} ${fmt(s.lastHumanAt, lang)}`)))),
          h('div', { className: 'kc-note' }, t('proposalNote')),
          null),

        h('section', { className: 'kc-card' },
          h('h3', { className: 'kc-h' }, h('span', { className: 'kc-dot' }), t('plugins')),
          h('div', { className: 'kc-pnote' }, t('pluginsNote')),
          // 只有「可开关插件之间」的依赖才需要提醒——基础库关不了，提它没有意义。
          // 原来那句「带依赖的不能单独关：先关上层」既夸大了范围，方向也写反了
          // （要关上游，得先关**依赖它的下游**）。
          (() => {
            const byId = new Map(plugins.map((p) => [p.id, p]));
            const pairs = [];
            for (const p of plugins) {
              if (p.toggleable === false) continue;
              for (const d of p.deps ?? []) {
                const up = byId.get(d);
                if (up && up.toggleable !== false) pairs.push(`${p.label} → ${up.label}`);
              }
            }
            return pairs.length > 0
              ? h('div', { className: 'kc-pnote' }, t('pluginsDeps'), pairs.join('、'))
              : null;
          })(),
          // 分类从数据里来：顺序优先按 order，没列到的排后面。
          // 新增分类只要在包的 package.json 里写 dsh.pisces.category 就会自动出现。
          (() => {
            const order = ['memory', 'talk', 'rhythm', 'safety', 'base', 'gate'];
            const seen = [...new Set(plugins.map((p) => p.cat))];
            return seen.sort((a, b) => {
              const ia = order.indexOf(a), ib = order.indexOf(b);
              return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            });
          })().map((cat) => {
            const rows = plugins.filter((p) => p.cat === cat);
            const label = t('cat_' + cat);
            return h('div', { key: cat, className: 'kc-pgroup' },
              h('div', { className: 'kc-phead' }, label === 'cat_' + cat ? cat : label),
              rows.map((p) => {
                const blocked = Array.isArray(p.blockedBy) && p.blockedBy.length > 0;
                const isLib = p.toggleable === false;
                // 第二行：解释。库写「为什么没有开关」；被挡住写「被谁挡」；其余写包自己的 desc。
                const desc = isLib
                  ? (p.why || p.desc)
                  : (blocked ? `${t('blocked')}${p.blockedBy.join(', ')}` : (p.desc || ''));
                return h('div', { key: p.id, className: 'kc-prow' },
                  h('div', { className: 'kc-picon', 'data-cat': p.cat }, h('span', null, (p.label || '?').slice(0, 1))),
                  h('div', { className: 'kc-pmain' },
                    // 第一行：插件名 + 包名（包名作为弱化的次要信息，跟在名字右边）
                    h('div', { className: 'kc-ptitle' },
                      h('span', { className: 'kc-pname' }, p.label),
                      h('span', { className: 'kc-ppkg' }, p.pkg)),
                    desc ? h('div', { className: 'kc-pdesc' + (blocked ? ' warn' : '') }, desc) : null),
                  isLib
                    ? h('span', { className: 'kc-pbadge' }, t('lib'))
                    : h('button', {
                      className: 'kc-switch' + (p.enabled ? ' on' : '') + (blocked ? ' blocked' : ''),
                      role: 'switch',
                      'aria-checked': p.enabled ? 'true' : 'false',
                      disabled: pluginBusy === p.id || (!p.enabled && blocked),
                      title: blocked ? `${t('blocked')}${p.blockedBy.join(', ')}` : (p.enabled ? t('turnOff') : t('turnOn')),
                      onClick: () => togglePlugin(p.id, !p.enabled, p.revision),
                    }, h('i', null)));
              }));
          })),
        h('section', { className: 'kc-card' },
          h('h3', { className: 'kc-h' }, h('span', { className: 'kc-dot' }), t('identity')),
          h('div', { className: 'kc-row' },
            h('input', { className: 'kc-select', readOnly: true, value: st.coreFile || '—', onFocus: (e) => e.target.select() }))),
        ),
        dirty && h('div', { className: 'kc-savebar' },
          h('button', { className: 'kc-btn', onClick: saveAll }, t('save'))),
      );
    }

    return {
      // 2026-11-16：locale 不是可 inject 的客户端席位令牌，写进去会让 apply 永不激活
      // （左栏入口消失）。只 inject slots；locale 用 ctx.locale 防御性读取。
      // 照官方 client 写法（@deepseek-ai/dsh-client-ui-plugin-manager：
      // inject=['slots','locale',...]）：依赖全写在静态 inject 里，直接 ctx.slots.inject 注册。
      // 不要用动态 ctx.inject(['layout'], ...) 把注册包起来——回调不触发就等于什么都没注册，
      // 而且不报错（2026-11-16 排查了半天）。
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const dz = ctx.locale.register(NS, 'zh', DICT.zh);
          const de = ctx.locale.register(NS, 'en', DICT.en);
          return () => { dz(); de(); };
        }, 'pisces: dictionaries');

        const lang = () => (/^zh/i.test(String(ctx.locale.getLocale().active)) ? 'zh' : 'en');

        let stopMain, stopSide;
        const mount = () => {
          stopMain?.(); stopSide?.();
          const L = lang();
          const tt = (k) => (DICT[L] || DICT.en)[k] ?? k;
          stopMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, { t: tt, lang: L })));
          stopSide = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: () => tt('nav'), locale: NS }, Icon));
        };
        // 宿主语言切换时重挂席位，使左栏标签与面板跟随（不中英同显）。
        ctx.effect(() => {
          mount();
          const un = ctx.locale.subscribe(mount);
          return () => { un(); stopMain?.(); stopSide?.(); };
        }, 'pisces: panel slots');
      },
    };
  },
});

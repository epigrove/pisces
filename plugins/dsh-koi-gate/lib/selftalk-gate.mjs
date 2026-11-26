// selftalk 门控实现（由 bootstrap.js 引入，避免模板字符串转义问题）
// 规则从 .koi/gate-rules.json 读，部署方可以自行调整。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 2026-11-14：退场语守卫的入站标记（带图/点名），与出口 guardExit 共享状态。
// 2026-11-17：判定在这里，共享的标记表在 dsh-koi-rules（通道无关）。
// 2026-11-17：这两个函数住在 rules 里，别绕道 says 拿。
// 原来从 says 拿，等于「入口门控」为了两个标记函数拖进整个出口包——
// 依赖方向反了（入口不该依赖出口）。
import { markImage, markNamed } from './turn-state.mjs';
import { personKeyOf } from 'dsh-koi-decay';
// 2026-11-16 codex P1：AI 配置统一读口。漏了这行，判官分支会抛 ReferenceError，
// 被外层 try 吞成 verdict='no'——所有非硬放行的消息被静默丢掉。

/** 用户配置的名字是字面量，不是正则源码。 */
export function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把消息正文里的 <@32位openid> 补成「@谁」。
 *
 * 群消息出现 <@某openid> 时，agent 无法仅凭 id 判断是谁在叫它。
 *
 * ⚠️ 注意对话里临时给出的身份对照**可能错**：说「A 是甲、B 是乙」时，
 *    身份卡里记的可能是另一个映射，甚至 B 根本不在表里。
 *    所以**不写死任何表**：每次从 .koi/lexicon.json 的 people 读（键是 openid 前 8 位）。
 *    身份卡更新后，这里自动跟着变。
 *
 * 做法是**追加**一行补充，不改原正文（不破坏原话，记忆层仍记原样）。
 */
function resolveMentions(text, selfOpenid, peopleOf) {
    const ids = [...String(text).matchAll(/<@([0-9A-Fa-f]{32})>/g)].map((mm) => mm[1]);
    if (ids.length === 0) return '';
    const people = peopleOf();
    const parts = [];
    for (const id of ids) {
        if (selfOpenid && id.toLowerCase() === selfOpenid.toLowerCase()) {
            parts.push(`<@${id}> 是我自己`);
            continue;
        }
        const name = people[id.slice(0, 8).toLowerCase()];
        // 「没认出这个 id」不等于「不认识这个人」：可能只是 id 与名字对不上。
        // 因此只说「这个 id 对不上」，不把缺失的映射当作否定认识的证据。
        parts.push(
          name ? `<@${id}> 是 ${name}` : `<@${id}> 这个 id 对不上（不代表不认识这个人）`,
        );
    }
    return `（补充：${parts.join('；')}）`;
}

export function installSelftalk(bot, ctx, config) {
    const OFF = process.env.QQBOT_SELFTALK_OFF === '1';
    // 2026-11-10：日志**默认开**。原来要显式 QQBOT_SELFTALK_LOG=1，
    // 结果门控在跑却完全看不到它做了什么（218 次初始化、0 条决策）。
    // 判断这东西不看日志等于没写——出问题只能猜。
    const GATE_LOG = process.env.QQBOT_SELFTALK_LOG !== '0';
    const CONTINUE_MS = Number(process.env.QQBOT_CONTINUE_MS ?? '120000');
    // 别名里**不许有 agent 未确认的名字**。名字属于身份标识，
    // 随手加一个，其他人就会跟着使用。默认只保留明确配置的通用称呼。
let ovN={}; if(existsSync(join(process.env.KOI_HOME ?? homedir(), '.koi', 'ashu-config.json'))){ try{ ovN=JSON.parse(readFileSync(join(process.env.KOI_HOME ?? homedir(), '.koi', 'ashu-config.json'),'utf8')).naming??{}; }catch(e){ console.log('[selftalk] 命名配置读失败：'+String(e)); } }
    const AGENT_NAME = ovN.agentName || process.env.KOI_AGENT_NAME || 'agent'; // 用户可给自己的 agent 命名
    const ALIAS = process.env.QQBOT_ALIASES ?? (ovN.aliases || AGENT_NAME);
    const KEYWORD = new RegExp(escapeRegExp(ALIAS), 'i');
    const RIVAL_ALIASES = Array.isArray(config?.rivalAliases)
        ? config.rivalAliases.filter((value) => typeof value === 'string' && value.trim() !== '')
        : [];
    const RIVAL = RIVAL_ALIASES.length > 0
        ? new RegExp(RIVAL_ALIASES.map((value) => escapeRegExp(value.trim())).join('|'), 'i')
        : null;
    /**
     * 身份卡：openid 前 8 位 → 名字（2026-11-13）
     * 从 .koi/lexicon.json 读，10 分钟缓存一次。读不到就返回空——只是解析不出名字，不崩。
     */
    const LEXICON = `${process.env.KOI_HOME ?? homedir()}/.koi/lexicon.json`;
    let peopleCache = {};
    let peopleAt = 0;
    function peopleOf() {
        if (Date.now() - peopleAt < 10 * 60_000) return peopleCache;
        peopleAt = Date.now();
        try {
            const raw = JSON.parse(readFileSync(LEXICON, 'utf8'));
            const people = raw?.people ?? raw?.v3?.people ?? {};
            const out = {};
            for (const [k, v] of Object.entries(people)) {
                // 2026-11-17：键的规整统一走 decay 的 personKeyOf，
                // 不再在这里自己写一份正则（原来是两套口径，今天就栽在这上面一次）。
                const key = personKeyOf(k);
                if (key === null) continue; // 无 id 的条目（name:xxx）@ 不到，认人时跳过
                out[key] = String(v?.name ?? v?.nick ?? v ?? key);
            }
            peopleCache = out;
        } catch {
            /* 读不到就沿用上次的 */
        }
        return peopleCache;
    }

    /** 她自己的 openid：从 `mentions[].is_you` 学（SDK 会标），学到一次就记住 */
    let selfOpenid = process.env.QQBOT_SELF_OPENID ?? '';
    function learnSelf(m) {
        if (selfOpenid !== '') return selfOpenid;
        try {
            const list = m?.mentions;
            if (Array.isArray(list)) {
                const me = list.find((x) => x?.is_you === true);
                const id = me?.member_openid ?? me?.openid ?? me?.id;
                if (typeof id === 'string' && /^[0-9A-Fa-f]{32}$/.test(id)) selfOpenid = id;
            }
        } catch {
            /* 学不到就算了，解析时会说「这个 id 对不上」 */
        }
        return selfOpenid;
    }

    const lastBotAt = new Map();
    /** 每个发送者上一句文本（判复读用） */
    const lastBySenderText = new Map();
    /** 每个群最近几条消息（含当前这条）；只用于「攒够才叫」的判断和问句上下文 */
    const recentByGroup = new Map();
    /** 每个群每个人的上一条消息时刻（判「是不是还在攒」） */
    const batchAtBySender = new Map();

    // ══ 第一级：信号评分 ══
    // 运维方的硬规则（结构性，不交给概率） + 她的软信号（交给模型判）
    // 硬判定：只有这三条能直接放行。owner 发言不再自动放行：
    // 与 agent 无关的话题不需要因为 owner 发言就回复；只有问句、点名或聊到 agent 时，
    // 才继续交给软门控判断。
    // 判据是「这句话是不是冲 agent 说的」，不是「有没有情绪」。
    // 单字圈话、喊累等弱信号不单独叫醒；@、名字和对端别名仍走硬放行。
    //
    // 所以这里只剩「是不是冲着她说的」，一个字的情绪、喊累、问句都不再单独放行。
    const STRONG = [
        [/<@([A-Za-z0-9]*?)(?:_)?>|@(?:你|参考 agent)/, 'at'],
        [KEYWORD, 'alias'],
        ...(RIVAL ? [[RIVAL, 'rival']] : []),
    ];

    /**
     * 三级判定（2026-11-10 重写）：
     *   pass   冲着她说的话：@、名字、别名 → 直接放行
     *   judge  没点名、但同一件事**连着三条以上**在讲 → 交给她自己判（攒够才叫）
     *   drop   其余一律不叫
     *
     * 这里**不再有分数**。原来那套「问句+2 / 情绪+1 / 主人+2」是拿数值凑出一个看起来正常的结果，
     * 判的不是意思。
     */
    /**
     * 规则从文件读（2026-11-10 主人定：**规则的事允许参考 agent改**）。
     *
     * 她改 `.koi/gate-rules.json` 就行，不用改代码、不用找我。
     * 每次判定时重读（文件很小），改完立刻生效。
     *
     * 读不到就用下面的默认值 —— 文件坏了不能把门拆了。
     */
    const RULES_FILE = process.env.QQBOT_GATE_RULES ?? join(process.env.KOI_HOME ?? homedir(), '.koi', 'gate-rules.json');
    let rulesCache = { at: 0, data: null };
    function loadRules() {
        const now = Date.now();
        if (rulesCache.data !== null && now - rulesCache.at < 3000) return rulesCache.data;
        try {
            const raw = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
            rulesCache = { at: now, data: raw };
            return raw;
        } catch (err) {
            if (rulesCache.data === null) {
                console.log('[selftalk] ⚠️ 规则文件读不到，用默认值：' + (err instanceof Error ? err.message : String(err)));
            }
            return rulesCache.data ?? {};
        }
    }
    // 硬放行规则：优先文件，退回写死的默认
    function strongRules() {
        const r = loadRules();
        if (Array.isArray(r.hardPass) && r.hardPass.length > 0) {
            return r.hardPass
                .map((x) => {
                    try { return [new RegExp(x.pattern, 'i'), x.why ?? 'rule']; } catch { return null; }
                })
                .filter(Boolean);
        }
        return STRONG;
    }
    function consecutive() {
        const r = loadRules();
        const v = Number(r.consecutive);
        return Number.isFinite(v) && v > 0 ? v : Number(process.env.QQBOT_CONSECUTIVE ?? '3');
    }
    function batchMs() {
        const r = loadRules();
        const v = Number(r.batchMs);
        return Number.isFinite(v) && v > 0 ? v : Number(process.env.QQBOT_BATCH_MS ?? '300000');
    }

    /**
     * 这条消息是不是「@ 到 agent 自己」。
     *
     * 已知 bug：别人 @ 的是第三人，agent 却抢着接话。
     * 根因：硬放行的 at 正则是 `<@任意id>`，谁被 @ 都放行。
     * 现在 at 这条必须真的 @ 到 agent 自己才算数。
     *
     * 判据（任一）：SDK 标了 is_you；@ 列表里有她自己的 openid；正文 @你/@参考 agent/@agent。
     */
    function atSelf(m, text) {
        if (Array.isArray(m?.mentions) && m.mentions.some((x) => x?.is_you === true)) return true;
        const self = String(selfOpenid ?? '').toLowerCase();
        const ids = [...String(text).matchAll(/<@([0-9A-Fa-f]{32})>/g)].map((x) => x[1].toLowerCase());
        if (self !== '' && ids.includes(self)) return true;
        return /@(?:你|参考 agent|agent)/.test(text);
    }

    function prescore(m, recent) {
        /**
         * 机器人自己（或别的 bot）发的东西一律不进，**排在最前**：
         * 本部署没开 skipSelfEcho，这道判断是唯一的回声保护。
         * 放在强规则之后的话，她发的图/带关键词的话被回显回来仍会被叫醒，自己回自己
         * （codex review P1，2026-11-19）。
         */
        if (m?.senderIsBot === true) return { verdict: 'drop', why: 'bot' };
        const text = String(m.content ?? '').trim();
        // 2026-11-15 参考 agent：@ 列表不含自己 → 是冲别人说的，不进回复队列（不靠退场语糊）
        if (/<@[0-9A-Fa-f]{32}>/.test(text) && !atSelf(m, text)) {
            return { verdict: 'drop', why: 'at-other' };
        }
        for (const [re, why] of strongRules()) if (re.test(text)) {
            // 2026-11-14：at 必须真的 @ 到她自己，@ 别人不算点名
            if (why === 'at' && !atSelf(m, text)) continue;
            return { verdict: 'pass', why };
        }
        /**
         * 带图消息曾只得到一句泛泛回复。
         *
         * 根因不在出口，在**这里**：单张图单独发来是一条消息，
         * 攒不够 consecutive(2) → `drop thin` → **agent 根本没见过那张图**，
         * 自然只能拿一句场面话收尾。
         *
         * 所以：带图的直接叫醒（和 @ 同级），别攒。图的内容她还看得见（read 本地路径）。
         */
        // 带图的直接叫醒（只认图片，语音/文件不在此列）
        if (Array.isArray(m?.attachments) && m.attachments.some((a) => /^image(?:\/|$)/i.test(String(a?.content_type ?? a?.contentType ?? '')))) {
            return { verdict: 'pass', why: 'image' };
        }
        // `recent` 是「包含当前这条」的窗口：攒够 3 条（含当前）才判
        const list = Array.isArray(recent) ? recent : [];
        if (list.length + 1 < consecutive()) return { verdict: 'drop', why: 'thin' };
        return { verdict: 'judge', why: 'consecutive' };
    }

    bot.use(async (c, next) => {
        const m = c.message;
        if (m.kind !== 'group') return next();
        const gid = m.groupOpenid ?? m.senderId ?? '';
        const now = Date.now();
        let text = String(m.content ?? '').trim();
        // 2026-11-13：把 <@openid> 补成人名，免得她「认不出这是谁在叫」
        try {
          const extra = resolveMentions(text, learnSelf(m), peopleOf);
          if (extra !== '') text = `${text}\n${extra}`;
        } catch { /* 解析失败不影响主流程 */ }
        // 2026-11-14：给出口退场守卫打标记——带图 / 点名了她，就不许用退场语敷衍。
        // 每条消息刷新标记（反映最新一条），她输出实质内容时由 guardExit 清掉。
        try {
          const hasImage = /图片|表情/.test(String(m.content ?? ''))
            || (Array.isArray(m.attachments) && m.attachments.length > 0);
          markImage(gid, hasImage);
          markNamed(gid, atSelf(m, String(m.content ?? '')));
        } catch { /* 标记失败不影响主流程 */ }
        /**
         * 入口门控开关是 QQBOT_SELFTALK_OFF=1；关闭后群里有消息就唤醒 agent。
         *
         * 开关位置**在打标记之后**。
         * 原来这一句在最前面，一关就顺带把标记也关掉了：
         * 出口的退场守卫读不到「这条带图/点了名」，会静默失效——
         * 关一个开关却悄悄拆掉另一道保护，这是最不该有的联动。
         * 现在 OFF 只跳判定，不跳标记。
         */
        if (OFF) return next();
        const recentBot = now - (lastBotAt.get(gid) ?? 0) < CONTINUE_MS;
        // 修复：原来拿「agent 上一条说的话」和「群友现在说的话」比——
        // 两边根本不是同一个人的话，比出相等纯属巧合，判重毫无意义。
        //
        // 真正该判的是「agent 自己上一句和这一句重复」，那由引擎那边的 dup 处理。
        // 这里改成：**群友复读同一句**才算重复（避免刷屏触发）。
        // 最近几条群消息（给「攒够才叫」和问句用）：只留文本+谁说的
        const recent = (recentByGroup.get(gid) ?? []).slice();
        recentByGroup.set(
            gid,
            [...recent, { name: String(m.senderName ?? '群友'), text: text.slice(0, 120) }].slice(-5),
        );

        const dupOfSender = lastBySenderText.get(`${gid}:${String(m.senderId ?? '')}`) === text
            && text !== '';
        lastBySenderText.set(`${gid}:${String(m.senderId ?? '')}`, text);

        // 批窗口按「群 + 发送者」计算：同群不同人的连发互不影响。
        // 实际行为保留原样：同一人在 batchMs 内再次发来单条弱信号（thin）时，
        // 会执行 `c.stop('selftalk-repeat')`，这条消息不再沿中间件链继续。
        // 这是有意保留的省调用行为，不只是日志降级。
        const senderKey = `${gid}:${String(m.senderId ?? '')}`;
        const batchAt = batchAtBySender.get(senderKey) ?? 0;
        batchAtBySender.set(senderKey, now);
        const quickRepeat = now - batchAt < batchMs();

        const pre = prescore(m, recent);
        // 连发去重只压 drop/thin；judge 级不能在这里被吞掉。
        // 命中时当前行为就是 stop 整条中间件链，而不是只跳过完整轮。
        if (quickRepeat && pre.verdict === 'drop' && pre.why === 'thin') {
            if (GATE_LOG) console.log('[selftalk] stop by=repeat（同一人连发，不重复触发）');
            c.stop('selftalk-repeat');
            return;
        }
        if (GATE_LOG) {
            console.log('[selftalk] pre=' + pre.verdict + ' why=' + (pre.why ?? (pre.hits ?? []).join(',')) +
                        ' from=' + (m.senderName ?? '?'));
        }

        if (pre.verdict === 'pass') { lastBotAt.set(gid, now); return next(); }
        if (dupOfSender && pre.verdict !== 'pass') {
            if (GATE_LOG) console.log('[selftalk] skip by=dup（同一人复读同一句）');
            c.stop('selftalk-dup');
            return;
        }
        if (pre.verdict === 'drop') { c.stop('selftalk-quiet'); return; }
        // 连续对话：她 2 分钟内刚说过话，且这条是 judge 级 → 接着聊
        // （修复：原来这条排在 drop 判定**之前**，等于「非点名」一律放行。
        //  先 drop 再判断连续对话，避免两条规则互相抵消。）
        if (recentBot) { if (GATE_LOG) console.log('[selftalk] pass by=continue'); lastBotAt.set(gid, now); return next(); }

        // ── 第二级：交给模型判断 ──
        //
        // 问题需要提供最近五条、说话人和是否在讲 agent；只给一句孤立文本无法判断。
        // 问法改为「不说话会不会少一句」，并限定「要 / 不要 / 等下一句」三选。
        let verdict = 'no';   // 默认不叫。兜成"放行"就等于又回到每句都接。
        try {
            const llm = ctx.get('llm');
            if (llm?.stream) {
                const persona = String(config.directPrompt ?? '').slice(0, 200);
                const said = recent.length > 0
                    ? recent.map((r) => `- ${r.name}：${r.text}`).join('\n')
                    : `- ${m.senderName ?? '群友'}：${text.slice(0, 120)}`;
                const me = new RegExp(`${escapeRegExp(ALIAS)}|我`, 'i');
                const aboutMe = recent.filter((r) => me.test(r.text)).length;
                const ask = `${persona}

群里刚才在说：
${said}

（其中 ${aboutMe} 条提到了你或你的名字。没人 @ 你。）

我不说话，这里会不会少一句？
只回一个词：要 / 不要 / 等下一句`;
                let out = '';
                // 2026-11-10 修：原来读 MODEL_PROVIDER（值是 'deepseek'），
                // 但配置里的 provider 叫 **deepseek-official**——名字对不上，每次都抛错。
                // 现在显式用 deepseek-official，读不到就退回可用列表里的第一个。
                // 2026-11-10 codex review：`llm.providers` 不存在，要用 `listProviders()`。
                const names = (() => {
                    try { return (llm.listProviders?.() ?? []).map((p) => p.id ?? p.provider ?? p.name); }
                    catch { return []; }
                })();
                // 2026-11-16：去掉 aiConfig（面板只留 api 一处）。
                // 门控用 env 指定的 provider/model，没有就取可用列表第一个。
                const wantP = process.env.MODEL_PROVIDER ?? '';
                const wantM = process.env.MODEL_NAME ?? '';
                const provider = wantP && names.includes(wantP) ? wantP : (names[0] ?? '');
                const model = wantM;
                if (!provider) { console.log('[selftalk] 没有可用 provider，跳过判断'); return next(); }
                // deepseek-flash 是推理模型，会先把 token 花在思考上；关掉思考再给 16 个 token 才够回一个词。
                const stream = llm.stream({
                    provider,
                    model,
                    messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }],
                    maxTokens: 16,
                    // 2026-11-10 实测（直接打 API 验证）：
                    //   thinking:{type:'disabled'} → content:"要" ✅
                    //   reasoning_effort:'off'     → content:undefined ❌
                    //   都不给                      → content:"" ❌
                    thinking: { type: 'disabled' },
                });
                for await (const chunk of stream) {
                    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
                }
                // 三选：「等」和「不要」都不叫。只有明确的「要」才让她开口。
                verdict = /要/.test(out) && !/不要|等/.test(out) ? 'yes' : 'no';
            }
        } catch (err) {
            // 门控异常不能兜底成「永远放行」；默认开口会让门控失去作用。
            //
            // 所以：判断失败 = 不叫。日志照打，别静默。
            console.log('[selftalk] ⚠️ judge error（这轮不叫）=' +
                (err instanceof Error ? err.message : String(err)));
            verdict = 'no';
        }
        if (verdict === 'no') {
            if (GATE_LOG) console.log('[selftalk] skip by=self-judged');
            c.stop('selftalk-no');
            return;
        }
        if (GATE_LOG) console.log('[selftalk] pass by=judge');
        lastBotAt.set(gid, now);
        return next();
    });
    const _r = loadRules();
    console.log(
        '[selftalk] 已启用｜硬放行 ' + strongRules().length + ' 条｜攒够 ' + consecutive() + ' 条才判'
        + '｜规则文件 ' + RULES_FILE + (Object.keys(_r).length > 0 ? '' : '（读不到，用默认）'),
    );
}

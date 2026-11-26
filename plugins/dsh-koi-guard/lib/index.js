/**
 * dsh-koi-guard — agent 的护栏
 *
 * 只做**机器能确定**的判断：路径在不在白名单里。
 * 语义类的事（这句「别发」是不是"不要发"）不归它管——那应由模型判断。
 *
 * ── 现有规则 ──
 *   fs   read / glob / grep  —— 路径必须在白名单里
 *
 * ── 删掉的规则：send ──
 *
 * 2026-11-10 删的，不是没写完，是**方向错了**。
 *
 * 起因：曾把整本手册发进群，于是尝试增加"发文件前先问"的护栏。
 * 「什么算 owner 要求发」经过多轮修补：
 *   裸「发」→ 砍过头 → 锚定错 → 否定误伤 → 群友算数 →
 *   群历史认错人 → 私聊没标识 → 正文假标签 → 心跳注入 → 同批次绕过…
 * 每轮修一个又造一个，根因是**用正则解中文语义**。
 *
 * 最终决定：「发送意图」交给模型判断，不写小型解析器或词表；
 * 上一轮留下的隐患一并删除。
 *
 * 所以删了。正确的位置在协议层/通道层（qqbot 那层确认），不是护栏插件猜文本。
 *
 * ── fs 规则的历史（都别删，都是踩出来的）──
 * - 一开始只拦 read。`tool-fs-search` 提供 glob/grep，**不经过 read**，
 *   开了它却不拦等于开了后门：`grep pattern=sk- path=.env` 一次掏走密钥。
 * - 白名单里不能只看字面路径：`workspace/x -> .env` 这种符号链接要按真实路径判。
 * - 拒绝提示要用绝对路径。原来拼成 "~/.koi/workspace"，碰巧等价但看着像两个目录，
 *   容易让人怀疑自己拿错路径。
 *
 * ── 加新规则之前 ──
 * 先问一句：这条规则要靠词表/正则穷举中文语义吗？
 * 如果是，**它不该写成代码**——写成给模型的判定条件。
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';

export const name = 'koi-guard';
export const inject = ['tools'];


export function apply(ctx, config) {
  const home = String(config?.home || join(homedir(), '.koi'));
  // 相对路径的基准是 agent 根目录（.koi 的上一级），常见写法如「.koi/workspace/x.md」
  const base = String(config?.base || dirname(home));

  /**
   * 默认白名单。
   *
   * 2026-11-12：原来写的是 ['workspace','persona','lexicon']——
   * 但 .koi 下实际是 `profile.persona.md` / `profile.core.md` / `lexicon.json` 三个**文件**，
   * 没有 `persona` 和 `lexicon` 目录。默认值等于全指向不存在的位置。
   */
  const allow = (config?.allow ?? ['workspace', 'profile.persona.md', 'profile.core.md', 'lexicon.json']).map((d) =>
    isAbsolute(d) ? normalize(d) : normalize(join(home, d)),
  );

  /** 显式拒绝：凭据、环境变量、会话、聊天记录 */
  // 2026-11-17 补 chat.key：签名密钥。原来只在 denyFile 之外——
  // 一旦把 .koi 整个放开读，就能拿到密钥并伪造消息。
  const denyFile = /(^|\/)(\.env|\.credentials\.yaml|chat\.jsonl|chat\.key)$/i;
  const denyDir = /(^|\/)(sessions|storages)(\/|$)/i;

  function inside(p, root) {
    const rel = relative(root, p);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** 存在的路径取真实路径（解开符号链接）；不存在返回 null */
  /**
   * 取「文件系统真正会打开的那个路径」。
   *
   * 2026-11-26 review P1：原来只对**存在**的路径做 realpath，
   * 于是 `workspace/link/../secret`（link → /etc）这种写法里，
   * 字面 normalize 成 `workspace/secret`（不存在 → realpath 失败）
   * 就只剩字面路径参与判断，而内核解析到的是 `/secret` —— 白名单被绕过。
   *
   * 现在：往上找到**存在的祖先**做 realpath，再把剩下的段接回去。
   * 这样不存在的目标也能拿到它真实会落的位置。
   */
  function realOrNull(p) {
    try {
      if (existsSync(p)) return realpathSync(p);
      const tail = [];
      let cur = p;
      for (let i = 0; i < 64; i += 1) {
        const parent = dirname(cur);
        if (parent === cur) return null;
        tail.unshift(basename(cur));
        cur = parent;
        if (existsSync(cur)) {
          const real = realpathSync(cur);
          return join(real, ...tail);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 按**内核语义**逐段解析路径（2026-11-26 review P1）。
   *
   * `realpathSync('ws/up/../etc/hostname')`（up → /）在 Node 里会按字面把 `..` 拍平，
   * 报 `/tmp/.../workspace/etc` 不存在；而内核打开时会先跟随 `up` 到 `/`，
   * 再对 `/` 做 `..`（还是 `/`），最后进 `/etc`。两者不一致 → 护栏被骗过。
   *
   * 这里自己走一遍：每段都先 realpath（跟随软链），`..` 作用在**已解析的真实路径**上。
   */
  function resolveReal(p) {
    const abs = isAbsolute(p) ? p : `${base}/${p}`;
    const parts = abs.split('/').filter((x) => x !== '');
    let cur = '/';
    for (const seg of parts) {
      if (seg === '.') continue;
      if (seg === '..') { cur = dirname(cur); continue; }
      const next = cur === '/' ? `/${seg}` : `${cur}/${seg}`;
      try {
        cur = realpathSync(next);
      } catch {
        cur = next; // 还不存在：按字面继续，后面的段同理
      }
    }
    return cur;
  }

  /**
   * 相对路径不能只按一个基准解析：会话 cwd 有两种
   * （`.koi/workspace` 和 `.dsh-qqbot/workspace`），而真正动文件的是 read 工具自己。
   * 所以把每个候选基准都算一遍，只要有一个落在白名单里就放行。
   *
   * @returns {string|undefined} 拒绝理由；undefined = 放行
   */
  function verdictPath(raw, cwd) {
    if (typeof raw !== 'string' || raw.trim() === '') return '路径是空的。';
    const bases = [cwd, base].filter((b) => typeof b === 'string' && b !== '');
    /**
     * 2026-11-26 review P1：**raw 和 normalize 后的要分开算真实路径**。
     *
     * `workspace/up/../etc/hostname`（up → /）在字面上 normalize 成
     * `workspace/etc/hostname`（不存在），可内核解析到的是 `/etc/hostname`。
     * 先 normalize 再 realpath，就再也看不到那次穿越了。
     * 所以每个基准都保留**原始拼接**去取真实路径，和字面路径一起判。
     */
    // 注意：**不能用 join**——join 会先把 `..` 拍平，穿越痕迹就没了。
    // 这里要保留原始拼接串，交给文件系统去解析。
    const rawCandidates = isAbsolute(raw) ? [raw] : bases.map((b) => `${b}/${raw}`);
    const pairs = rawCandidates.map((rawPath) => {
      const literal = normalize(rawPath);
      const real = resolveReal(rawPath);
      return real !== literal ? [literal, real] : [literal];
    });

    for (const ps of pairs) {
      if (ps.some((x) => denyFile.test(x) || denyDir.test(x))) {
        return `「${raw}」不在我能读的范围里。`;
      }
    }
    for (const ps of pairs) {
      const allInside = ps.every((x) => allow.some((root) => x === root || inside(x, root)));
      if (allInside) return undefined;
    }
    return `只能读 ${allow.join('、')} 下面的文件。`;
  }

  /**
   * 取这条执行所属会话的 cwd，方式和 dsh-tool-fs 内部一致：
   * `ctx.workingDirectory.ensure(exec.agent, exec.signal)`。
   * 不能用 get(exec) —— 参数不是 agent，取不到会静默退回 base，判断就错位了。
   */
  async function cwdOf(exec) {
    try {
      if (exec.agent === undefined) return base;
      const wd = ctx.get('workingDirectory');
      const got = await wd?.ensure?.(exec.agent, exec.signal);
      if (typeof got === 'string' && got !== '') return got;
    } catch {
      /* 拿不到就退回 base（宁可多拒，不可漏放） */
    }
    return base;
  }

  // ── 规则表 ──────────────────────────────────────────────
  //
  // 一条规则 = 管哪些工具 + 怎么判 + 拒绝时说什么。
  // **加新护栏只加一条，不要新建插件。**
  const RULES = [
    {
      name: 'fs',
      tools: ['read', 'glob', 'grep'],
      /** @param {object} exec @returns {Promise<{ok:true}|{ok:false, why:string, hint:string}>} */
      async check(exec) {
        // 每个工具从参数里取哪个字段当路径
        const field = { read: 'file_path', glob: 'path', grep: 'path' }[exec.name];
        const raw = exec.arguments?.[field];
        // glob/grep 的 path 可以不填——那时它搜的就是会话 cwd，用 cwd 判
        const target =
          raw === undefined || raw === null || String(raw).trim() === ''
            ? await cwdOf(exec)
            : raw;
        const why = verdictPath(target, await cwdOf(exec));
        return why === undefined ? { ok: true } : { ok: false, why, hint: `读不了：${why}` };
      },
    },
    {
      /**
       * 写：比读**更窄**。
       *
       * 已开放插件源码读取权限，但没有开放写权限——现在靠 tool-fs 里
       * write/edit/applyPatch=false 挡着，也就是「工具不存在」。
       * 那是**一层**保护，不是权限。哪天有人把写工具打开，插件源码就变成可改的了。
       *
       * 所以补这条：即使写工具存在，也只能写到 workspace。
       * 判据是「权限而非约定」——README 里 Pirces 的核心设计之一。
       */
      name: 'write',
      // 2026-11-17 codex review P1：真实工具名是 **apply_patch**（下划线），
      // 而且它的参数只有 `input`（整段补丁文本），没有 file_path。
      // 原来写成 applyPatch + file_path → 这条规则对 apply_patch **永远不命中**，
      // 一旦 profile 打开 applyPatch，补丁写入就完全绕过护栏。
      tools: ['write', 'edit', 'apply_patch'],
      async check(exec) {
        // apply_patch 直接拒：当前没有打补丁场景，而从补丁文本里解析目标路径太脆。
        // 「用不上的能力就关掉」比「解析它再判断」安全。
        if (exec.name === 'apply_patch') {
          return { ok: false, why: '不允许打补丁', hint: '这个能力没有对 agent 开放。' };
        }
        const field = { write: 'file_path', edit: 'file_path' }[exec.name];
        const raw = exec.arguments?.[field] ?? exec.arguments?.path;
        if (raw === undefined || raw === null || String(raw).trim() === '') {
          return { ok: false, why: '写操作没给路径', hint: '不给路径的写一律拒。' };
        }
        const cwd = await cwdOf(exec);
        // 原始拼接串（不经 join/normalize）：`..` 必须留给文件系统去解析，
        // 否则 `workspace/link -> /` 再 `../etc/x` 的穿越痕迹会被拍平。
        const rawStr = String(raw);
        const rawTarget = isAbsolute(rawStr) ? rawStr : `${cwd}/${rawStr}`;
        const target = normalize(rawTarget);
        const writable = normalize(join(home, 'workspace'));
        /**
         * 2026-11-17 codex review P2：不能只 realpath 目标本身。
         * write 的目标**通常还不存在**，此时 realOrNull 返回 null，会退回字面路径；
         * 于是 `workspace/link/new.js`（link -> 外面）或 `workspace/link/../x`
         * 能通过检查，而 fs 层按物理路径写到工作区外面去。
         *
         * 做法：往上找**最近的存在祖先**，把它 realpath 出来，再把剩余段接回去。
         * 读规则早就这么防了（测试里有 workspace/x -> .env 那条），写规则漏了。
         */
        /**
         * 2026-11-26 第二轮 review：**沿原始路径逐段解析**，不要先 normalize。
         * 原来 `realOfNearest(target)` 用的是已经拍平的字面路径，
         * `workspace/link/../outside`（link → 白名单外）会被看成 `workspace/outside`，
         * 而内核实际解析到白名单外 → 写规则被绕过（读规则已修，写规则漏了）。
         */
        const real = resolveReal(rawTarget);
        const ok = real === writable || inside(real, writable);
        return ok ? { ok: true } : { ok: false, why: `不在可写范围（只有 workspace）`, hint: `只能在 ${writable} 下写。` };
      },
    },
    // ❗ 不在这加「say」规则：曾用正则判「这句是不是内部用语/半截」，
    // 根因仍是**用词表解中文语义**。文件头那段警告就是为这个写的。
    //
    // 出口检查（整条括号占位、内部用语、断句）交给模型按提示词判；
    // 引擎那侧发不发，是通道层的事，不是护栏插件猜文本。
  ];

  const off = ctx.on('tools/execute', async (exec, next) => {
    for (const rule of RULES) {
      if (!rule.tools.includes(exec.name)) continue;
      const r = await rule.check(exec);
      if (r.ok === true) return next();
      return {
        isError: true,
        error: { name: 'GuardRejected', message: r.why },
        content: [{ type: 'text', text: r.hint }],
      };
    }
    return next();
  });

  console.log(
    `[koi-guard] 已启用 ${RULES.length} 条规则：${RULES.map((r) => `${r.name}(${r.tools.join('/')})`).join('、')}`
    + `｜可读/可搜：${allow.join('、')}`,
  );
  return off;
}

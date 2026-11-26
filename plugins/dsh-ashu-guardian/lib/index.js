/**
 * dsh-ashu-guardian v1 — ashu的看护插件
 *
 * 目标：ashu（dsh web）一启动，就把 koi profile 一起拉起来；
 * 并且每分钟检查一次，掉线就重新拉起。
 *
 * 为什么不用 systemd：2026-11-06 实测，systemd 拉起 koi 时 spill-local
 * 会 EROFS（bwrap 与 systemd 的 mount namespace 冲突），工具面降级；
 * 用 detached 子进程启动则一切正常。所以这里用 detached spawn，
 * 与 shell 里 `./start-koi.sh --daemon` 起的效果一致。
 *
 * 行为：
 * - 首次启动：找已在跑的 koi；没有就用 script 拉起（setsid + 日志追加）
 * - 之后每 intervalMs 检查一次（读取日志最后修改时间 + 进程表）
 * - 插件卸载（dsh 关闭）时：默认保留koi继续跑，可用 killOnDispose 改
 */
import { spawn, execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'ashu-guardian';
// 不依赖任何服务：这是自包含的看护逻辑
export const inject = [];

/**
 * 2026-11-12：路径不再写死绝对位置，跟着 KOI_HOME 走
 * （和 dsh-ashu-relay 用同一个约定）。换机器/换用户只改环境变量。
 */
const KOI_HOME = process.env.KOI_HOME ?? join(homedir(), 'koi');
const DEFAULT_SCRIPT = `${KOI_HOME}/ops/start.sh`;
const DEFAULT_CWD = process.env.KOI_WORKDIR ?? join(homedir(), 'workspace');
const PATTERN = 'dsh --profile koi';

/**
 * 进程表里找 koi（返回 pid 列表）。
 * 用 -a 拿完整命令行再自己筛：pgrep -f 会把「命令行里含 PATTERN 的 shell」也算进来，
 * 2026-11-06 差点因此漏掉拉起。
 */
/**
 * 日志函数。
 *
 * 2026-11-12 **踩过**：我把这里统一改成 `ctx.logger?.info?.(…)`，
 * 结果 `ctx.logger` 在这个上下文里拿不到 → 可选链静默变成空操作，
 * **一条日志都不出**，重启后无法判断是否由 guardian 拉起。
 * 服务器重启后验证就是这么发现的：koi 起来了、guardian 零条日志。
 *
 * 所以：logger 有就用，没有必须退回 console.log。日志不能靠「碰巧存在」。
 */
let log = (msg) => console.log(`[ashu-guardian] ${msg}`);

function koiPids() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-af', PATTERN], { timeout: 5000 }, (err, stdout) => {
      // 2026-11-08 **修危险 bug**（codex 审计）：
      // pgrep 退出码 1 = 没找到（正常），其他（超时/EACCES/ENOENT）= **查不到**。
      // 原来两种情况都返回 []，于是"查不到"被当成"没有 koi"→ **又拉起一个**，
      // 两个 koi 抢同一个 QQ 连接。
      // 现在查不到就返回 null，调用方跳过这一轮。
      if (err && err.code !== 1) {
        log(`pgrep 失败（${err.code ?? 'timeout'}），本轮跳过，不启动`);
        return resolve(null);
      }
      const re = new RegExp('node .*' + PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
      const pids = String(stdout ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((line) => re.test(line))
        .map((line) => Number(line.split(' ')[0]))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
  });
}

/**
 * 拉起 koi 时，**把 ashu 的 API 配置同步过去**。
 *
 * 规则反过来了：以前是「摘掉 MODEL_*，跟随自己的会话」，
 * 现在是 **「agent 的 API 配置直接同步 ashu 的」**——一处改，两边一致。
 *
 * 同步的只是**模型选择**（provider/model/推理档），不含凭据本身：
 * 凭据在她自己的 .credentials.yaml 里，由 key-sync 检查覆盖情况。
 *
 * 本文件负责：拉起时传下去 + 定期检查对端是否真的跟着。
 */
const SYNCED_ENV = ['MODEL_PROVIDER', 'MODEL_NAME', 'MODEL_REASONING_EFFORT'];

function envForKoi(base = process.env) {
  // 全部继承（含 MODEL_*），让 agent 拿到与 ashu 相同的模型配置。
  return { ...base };
}

/** ashu当前的模型配置（用于对比）。 */
function myModelConfig(base = process.env) {
  return Object.fromEntries(SYNCED_ENV.map((k) => [k, base[k] ?? '']));
}

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    adopt: config.adopt !== false,
    // API 同步脚本（provider 定义 + 模型选择 + 凭据，全同步）
    syncScript: String(config.syncScript ?? ''),
    script: config.script ?? DEFAULT_SCRIPT,
    cwd: config.cwd || DEFAULT_CWD,
    // 2026-11-08：校验过的间隔。NaN/Infinity 会让 setInterval 按 1ms 跑，
    // 疯狂 pgrep 烧 CPU（codex 审计抓到）。
    intervalMs: (() => {
      const v = Number(config.intervalMs ?? 60000);
      return Number.isFinite(v) ? Math.min(Math.max(v, 15000), 3600000) : 60000;
    })(),
    killOnDispose: config.killOnDispose === true,
    // 默认不允许用旧 API 配置拉起；部署方明确接受陈旧配置时才设 true。
    allowStale: config.allowStale === true,
  };

  if (!cfg.enabled) {
    log('已禁用（config.enabled=false）');
    return;
  }

  // 没配启动脚本 = 这个部署不用本插件接管进程（开源模板就是留空的）。
  // 此时明确关掉 adopt，别让它每分钟报一次「启动脚本不存在」。
  if (String(cfg.script ?? '').trim() === '') {
    log('未配置启动脚本（script），只做巡检、不接管进程');
    cfg.adopt = false;
  }

  let child = null;      // 本插件拉起的直接子进程
  let timer = null;
  let lastStart = 0;
  let syncSkipLogged = false;
  const START_COOLDOWN_MS = 15000;   // 防止拉起/崩溃循环

  /**
   * 日志统一走 console.log（2026-11-12 定了两次）。
   *
   * 先试 `ctx.logger?.info?.()`：拿不到 logger 时可选链静默变空操作，**一条日志都没有**。
   * 再加「logger 没有就 console」的兜底：结果还是零日志——
   * 说明 `ctx.logger.info` 这个方法**存在但写不到 journald**（被级别过滤或换了 sink）。
   *
   * 结论：这个插件是运维用的，日志必须无条件可见。和 relay 一样直接用 console.log。
   * 验证方式：`journalctl -u dsh-web | grep ashu-guardian` 必须有输出。
   */
  log = (msg) => console.log(`[ashu-guardian] ${msg}`);

  function start(apiSynced) {
    if (!cfg.adopt) return false;
    if (Date.now() - lastStart < START_COOLDOWN_MS) return;
    if (!existsSync(cfg.script)) {
      log(`启动脚本不存在：${cfg.script}`);
      return false;
    }
    // 拉起之前先把 API 配置同步过去，保证她起来用的就是ashu的
    const synced = typeof apiSynced === 'boolean' ? apiSynced : syncApi();
    if (!syncConfigured()) {
      // 没配同步就是不需要，静默继续（不刷日志）
    } else if (!synced) {
      if (!cfg.allowStale) {
        log('API 同步失败，跳过本轮拉起（allowStale=false）');
        return false;
      }
      log('API 同步失败，按 allowStale=true 使用旧配置拉起');
    }
    lastStart = Date.now();
    // 启动器自己会 nohup/setsid 起后台进程；这里只需要等它把命令发出去
    child = spawn('/bin/bash', [cfg.script, '--daemon'], {
      cwd: cfg.cwd,
      detached: false,
      instrument: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envForKoi(),
    });
    let out = '';
    child.stdout?.on('data', (b) => { out += b.toString(); });
    child.stderr?.on('data', (b) => { out += b.toString(); });
    child.on('error', (e) => log(`拉起失败：${e?.message ?? e}`));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      log(`启动器退出（code ${code}）${line ? '：' + line : ''}`);
      child = null;
    });
    return true;
  }

  /**
   * 把ashu的 API 配置同步给她（2026-11-16 主人定：全同步）。
   * provider 定义 + 模型选择 + 凭据，一律以ashu为准。
   * 拉起之前跑一次，保证她起来用的是ashu的配置。
   */
  /** 这个部署到底配了同步没有（没配 = 不需要同步，不是失败） */
  const syncConfigured = () => String(cfg.syncScript ?? '').trim() !== '';

  function syncApi() {
    // 2026-11-17 codex review P2：syncScript 没配时不能硬跑。
    // `spawnSync(node, [''])` 会**退出码 0** 什么都不做——日志却像同步成功了。
    // 这种「假成功」比报错更坏：真出问题时看不出来。
    if (String(cfg.syncScript ?? '').trim() === '') {
      // 只记一次：这个函数每分钟被调用一次，否则日志会被同一句刷满
      if (!syncSkipLogged) {
        syncSkipLogged = true;
        log('未配置 syncScript，跳过 API 同步（不算成功）');
      }
      return false;
    }
    try {
      const r = spawnSync(process.execPath, [cfg.syncScript], { encoding: 'utf8', timeout: 30000 });
      if (r.status !== 0) {
        log(`API 同步失败（code ${r.status}）：${(r.stderr ?? '').slice(0, 200) || (r.stdout ?? '').slice(0, 200)}`);
        return false;
      }
      const out = (r.stdout ?? '').trim();
      if (out.includes('无需改动')) return true;   // 已经一致，不刷日志
      const did = out.split('\n').filter((l) => l.startsWith('✓'));
      if (did.length > 0) log(`API 已同步给她：${did.join('；')}`);
      return true;
    } catch (e) {
      log(`API 同步异常：${String(e)}`);
      return false;
    }
  }

  async function check() {
    /**
     * 2026-11-26 review P1：**同步失败不能连巡检一起停**。
     *
     * 原来这里 `if (!synced) return` —— 而 `syncScript` 默认是空（开源模板就留空），
     * 于是"没配同步"被当成"同步失败"，`check()` 永远在第一行返回：
     * 进程挂了也不会发现、也不会拉起。看护插件的存在意义整个消失。
     *
     * 现在分开：
     *   - 巡检（她还在不在）**永远做**，跟 API 同步无关
     *   - 只有"拉起"这一步受同步结果约束（allowStale 仍可放行）
     */
    const synced = syncApi();
    const pids = await koiPids();
    // null = 查不到（pgrep 失败），不是"没有"。跳过这一轮，别盲目启动。
    if (pids === null) return;
    if (pids.length > 0) return;
    // 进程没了：拉起（这一步才看同步结果）
    if (child && child.exitCode === 0) child = null;
    if (!cfg.adopt) return;
    /**
     * 2026-11-27：**没配 syncScript 不等于同步失败**。
     * 开源模板默认留空，如果留空就永远拉不起 koi，看护插件等于没有。
     * 只有"配了但执行失败"才拦拉起。
     */
    if (syncConfigured() && !synced && !cfg.allowStale) {
      log('API 同步失败，跳过本轮拉起（allowStale=false）');
      return;
    }
    start(synced);
  }

  // 启动时先看她一眼，没有就拉起
  // 2026-11-12：加一行启动日志。原来只有出错才说话，所以「它到底在不在跑、
  // 是不是新代码」完全看不出来——和 relay 那次「路由只能靠发消息试」同一个毛病。
  log(
    `已启用｜每 ${Math.round(cfg.intervalMs / 1000)} 秒看一次 ${PATTERN}`
    + `｜她的 API 配置全同步我的（provider 定义 / 模型选择 / 凭据）`,
  );
  check().catch((e) => log(`首次检查失败：${e?.message ?? e}`));

  timer = setInterval(() => {
    check().catch((e) => log(`巡检失败：${e?.message ?? e}`));
  }, cfg.intervalMs);
  timer.unref?.();

  ctx.effect(() => () => {
    if (timer) clearInterval(timer);
    timer = null;
    // 2026-11-12：spawn 用的是 detached:false，它**没有自己的进程组**，
    // `process.kill(-pid)` 打的是「pid 这个组」——组不存在时抛错，或者更糟，
    // 误伤同组别的进程。这里只杀直接子进程（启动脚本本身）。
    if (cfg.killOnDispose && child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch (err) {
        log(`收尾时杀子进程失败（忽略）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 'ashu-guardian timer');
}

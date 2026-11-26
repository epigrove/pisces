/**
 * paths.mjs —— 所有"这套系统装在哪"的约定集中在这里。
 *
 * 为什么要集中（2026-11-16）：
 *   同一个路径散在 5 个文件里，换一台机器就要逐个找、逐个改，漏一个就是
 *   "在我这能跑"。这些路径本身没有逻辑，全部收口到一个文件，改一处就够。
 *
 * 所有路径都可以被环境变量覆盖，默认值只是"参考实现的常见布局"。
 * **插件代码不应该 import 这个文件**——插件通过 KOI_HOME 拿数据目录就够，
 * 不该知道 profile 怎么摆。这个文件是给运维脚本（ops/、tools/）用的。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 参考实现 agent（koi）的数据根 */
export const KOI_HOME = process.env.KOI_HOME ?? join(homedir(), 'koi');

/** 参考实现 agent 的 DSH_HOME（插件、profile、会话都在它下面） */
export const KOI_DSH_HOME = process.env.KOI_DSH_HOME ?? join(KOI_HOME, '.dsh-home');

/** 参考实现 agent 的 profile 目录 */
export const KOI_PROFILE = process.env.KOI_PROFILE ?? join(KOI_DSH_HOME, 'profiles', 'koi');

/** koi 的 agent 数据目录（记忆、词典、白名单都在这） */
export const KOI_DATA = process.env.KOI_DATA ?? join(KOI_HOME, '.koi');

/** 运维方（ashu）的 DSH_HOME */
export const ASU_DSH_HOME = process.env.ASU_DSH_HOME ?? join(homedir(), '.dsh');

/** 运维方的 profile 目录 */
export const ASU_PROFILE = process.env.ASU_PROFILE ?? join(ASU_DSH_HOME, 'profiles', 'web');

/** 常用文件的完整路径 */
export const FILES = {
  // —— koi 侧 ——
  koiPatch: join(KOI_PROFILE, 'cordis.patch.yml'),
  koiProviders: join(KOI_PROFILE, 'llm-providers.yml'),
  koiProfilePkg: join(KOI_PROFILE, 'package.json'),
  koiPatches: join(KOI_PROFILE, 'patches'),
  koiConfig: join(KOI_DATA, 'ashu-config.json'),
  koiChat: join(KOI_DATA, 'chat.jsonl'),
  koiLexicon: join(KOI_DATA, 'lexicon.json'),
  koiGateRules: join(KOI_DATA, 'gate-rules.json'),
  koiWhitelist: join(KOI_DATA, 'outbound-whitelist.json'),
  koiStatusSent: join(KOI_DATA, 'status-sent.json'),
  koiCreds: join(KOI_DSH_HOME, '.credentials.yaml'),
  koiEnv: join(KOI_HOME, '.env'),

  // —— 运维方侧 ——
  asuPatch: join(ASU_PROFILE, 'cordis.patch.yml'),
  asuCreds: join(ASU_DSH_HOME, '.credentials.yaml'),
};

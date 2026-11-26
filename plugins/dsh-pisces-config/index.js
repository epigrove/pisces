/**
 * dsh-pisces-config —— 配置的唯一读口。
 *
 * 这里回答两类问题，因为它们都是"配置说了算"：
 *   1. **用哪个模型**    aiConfig / koiModel / pickModel
 *   2. **投递到哪**      pickAgent / lastHumanAt / idOf / isSubAgent
 *
 * 2026-11-16 从 dsh-pisces-session 整体并入：面板上就是「API」和「提案会话」
 * 两处配置，读它们的代码放一起，不再横跨两个包。
 */
export * from './ai-config.mjs';
export * from './identity.mjs';

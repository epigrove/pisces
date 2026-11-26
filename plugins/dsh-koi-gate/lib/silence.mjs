/**
 * 静默词：agent 用这个 token 表示「这轮我不说话」。
 *
 * 通道看到它就不发，也不补一句替它。
 * 挑一个平时绝不会说出口的组合，避免误命中正常说话。
 */
/**
 * 选定的静默词：`#静默#`
 *
 * 换掉原来的旧短语——它是一句正常的中文告别语，同时又在退场语表里，
 * 结果「拿它当告别语说」会被静默判定吞掉，群里一个字都看不到。
 *
 * 选择 `#静默#` 的理由：普通对话不会顺口说出这四个字符，
 * 它不像告别语或状态语；中间夹符号，也不容易被误认成名字、@ 或半句话。
 * 它足够显眼，万一漏到公开通道，能立刻识别为控制信号未被执行。
 */
export const SILENCE_TOKEN = '#静默#';

/**
 * 这条是不是「agent 声明不说话」。
 * @returns {{silent:true} | {silent:false}}
 */
export function isSilenceToken(text) {
  return String(text ?? '').trim() === SILENCE_TOKEN ? { silent: true } : { silent: false };
}

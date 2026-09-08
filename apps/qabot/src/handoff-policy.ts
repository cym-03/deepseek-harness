const HUMAN_HANDOFF_STATEMENTS = [
  /推荐.{0,8}(?:转接|联系|咨询)?人工(?:处理|协助|服务|办理)?/u,
  /建议.{0,8}(?:转接|联系|咨询)人工(?:处理|协助|服务|办理)?/u,
  /(?:需要|需由).{0,12}人工(?:处理|协助|介入|办理)/u,
] as const

/** Returns whether an assistant answer explicitly recommends human handling. */
export function answerRecommendsHumanHandoff(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '')
  return HUMAN_HANDOFF_STATEMENTS.some(pattern => pattern.test(normalized))
}

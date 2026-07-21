export const TRADE_ACTION_PATTERN =
  /\b((?:buy|sell|hold|accumulate)\s+(?:(?:this|that|the|a|an)\s+)?(?:shares?|stocks?|securit(?:y|ies)|instrument|position)|go long|go short|short this|reduce exposure|increase exposure|trim exposure|add exposure|rebalance (?:of )?(?:the |your )?(?:portfolio|account)|take profit|stop loss|position size|position sizing|open (?:a |the )?position|take (?:a |the )?position|add shares|trim shares|scale in|scale out|set (?:an? )?entry|entry point|exit at|exit point|execute (?:a |the )?(?:trade|order)|execution instruction|portfolio change|allocation change)\b/iu;

const TICKER_TRADE_ACTION_PATTERN =
  /\b(?:buy|Buy|BUY|sell|Sell|SELL|hold|Hold|HOLD|accumulate|Accumulate|ACCUMULATE)\s+(?:this\s+)?[A-Z]{1,5}\b/u;

const IMPERATIVE_TRADE_ACTION_PATTERN =
  /\b(?:Buy|Sell|Hold|Accumulate)\s+(?:after|before|on|at|if|when)\b/u;

/*
 * Sentence-initial imperative advice: a capitalized trade verb at the start of the
 * text or a clause ("Buy now", "Sell immediately", "Hold for upside", "Buy the dip").
 * Descriptive prose keeps these verbs lowercase and mid-sentence ("customers buy
 * devices", "Apple sells services"), so it stays clear. The `(?!-)` guard spares
 * finance compounds like "Sell-side"/"Buy-side".
 */
const SENTENCE_INITIAL_TRADE_ACTION_PATTERN =
  /(?:^|[.!?;:\n])[\s*•-]*(?:Buy|Sell|Hold|Accumulate)\b(?!-)/u;

export const READER_DIRECTED_ADVICE_PATTERN =
  /\b(?:investors|traders|readers|you)\s+(?:should|could|may want to|might want to|need to|must)\b|\b(?:should|must|need to)\s+(?:buy|sell|hold|open|trim|add|exit|enter|reduce|increase|rebalance)\b/iu;

export const VALUATION_CERTAINTY_PATTERN =
  /\b(?:fair value|margin of safety|undervalued|overvalued|target price)\b/iu;

export function violatesResearchOnly(text: string): { match: string } | null {
  const m =
    TRADE_ACTION_PATTERN.exec(text) ??
    TICKER_TRADE_ACTION_PATTERN.exec(text) ??
    IMPERATIVE_TRADE_ACTION_PATTERN.exec(text) ??
    SENTENCE_INITIAL_TRADE_ACTION_PATTERN.exec(text) ??
    READER_DIRECTED_ADVICE_PATTERN.exec(text) ??
    VALUATION_CERTAINTY_PATTERN.exec(text);
  return m !== null ? { match: m[0].trim() } : null;
}

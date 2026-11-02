'use strict';
// A review failure carries what the user needs (R17): which step, why, what
// to do next. What happens to the queue is decided by the engine:
//   kind 'env'     → environment-level: always stops the queue and pauses all automation
//   kind 'step'    → steps 1–5 (incl. a timeout there): only this review
//   kind 'ai'      → steps 6–7: stops the queue only when「失败时停止队列」is on
//   kind 'context' → step 6 context overflow: only this review
class ReviewFailure extends Error {
  constructor({ step, kind, code, title, reason, next, detail, unread }) {
    super(title || reason);
    this.step = step;
    this.kind = kind;
    this.code = code;
    this.title = title;
    this.reason = reason;
    this.next = next || '';
    this.detail = detail || '';
    this.unread = unread || null;
  }
  toJSON() {
    return { step: this.step, kind: this.kind, code: this.code, title: this.title, reason: this.reason, next: this.next, detail: this.detail, unread: this.unread };
  }
}

class Stopped extends Error {
  constructor(reason) { super(reason || '已主动停止'); this.reason = reason || '已主动停止'; }
}

// R11: one timeout for the whole review, counted from step 1 (queue time excluded).
function timeoutFailure(step, minutes, elapsedMs) {
  return new ReviewFailure({
    step, kind: step >= 6 ? 'ai' : 'step', code: 'REVIEW_TIMEOUT',
    title: '步骤 ' + step + '/7 超时',
    reason: '检视总时长超过「检视超时」（' + minutes + ' 分钟），已终止该检视的全部子进程',
    next: '大 MR 需要更长时间时，在「设置」中调大「检视超时」和「收尾时间」后重新检视。',
    detail: 'elapsed=' + Math.round((elapsedMs || 0) / 1000) + 's limit=' + minutes + 'm'
  });
}

module.exports = { ReviewFailure, Stopped, timeoutFailure };
